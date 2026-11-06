# Ingest WAL durability

The ingest gateway (`apps/ingest`, Rust) acknowledges a request once the rows are committed to a
local write-ahead log, then exports them to Tinybird or ClickHouse in the background. That WAL is
the only copy of an accepted row until it reaches the warehouse. In prd it lives on the EC2 host's
NVMe instance store (`/mnt/wal`, bind-mounted into the task), which survives a reboot but is wiped
when the instance stops or is replaced. On a Fargate task it lives on ephemeral storage, which is
destroyed with the task.

This is how it stays durable.

## Ingest rules

Customer drop and redact rules ([ingest-rules.md](ingest-rules.md)) run in
`process_decoded_payload`, before the payload splits into the native WAL path and the collector
forward. A dropped record is never appended and a redacted value is rewritten first, so the raw
value never reaches the WAL on disk, the segments shipped to S3, or the collector. Replaying a WAL
or an S3 segment therefore never needs the rules again.

## The log

One **lane** per `(shard, destination)` (see `lane_index` in `apps/ingest/src/telemetry.rs`). Lanes
are independent, so a stalled ClickHouse export cannot back up the Tinybird lane sharing its shard.

Each lane is a directory of sealed segments:

```
$INGEST_QUEUE_DIR/shard-003-clickhouse/
  000000000041.seg     ← sealed, waiting to export
  000000000042.seg     ← sealed
  000000000043.seg     ← active; appends land here
  lane.cursor          ← "42 1048576": exported through segment 42, byte 1048576
```

Appends go to the active segment and `sync_data` before the request is acknowledged. At
`INGEST_WAL_SEGMENT_MAX_BYTES` (8 MiB) the segment is **sealed**: the file is closed and the next
one opened. Sealing is an `open` plus a directory fsync. There is no copy on the append path.

Syncs are **group commits**. An append writes its frame under the lane's append lock, then waits
for a sync that started after the write. If no sync is running it leads one: it takes every frame
written since the last sync, releases the lock, calls `sync_data`, and on success hands those frames
to the export channel in segment order before waking their appenders. Frames written while that
sync runs join the next one. A request is still acknowledged only after a sync that covers its
bytes; what changed is that one slow fsync now costs a request about two syncs instead of one per
append queued ahead of it on the lane. A failed sync refuses every frame in its batch: none is
delivered or counted as backlog, and each request's org reservation is released. A full segment
takes no more frames until it is synced and sealed, so a segment still overshoots by at most one
frame.

The exporter advances `lane.cursor` and unlinks every segment behind it. **Appends and exports take
different locks**, so an export can never stall a commit. That separation is the fix for the
`ingest.wal_commit` p95 that used to swing between 145ms and 998ms against a flat 3ms p50: the
previous layout was one file per lane, reclaimed by rewriting the unexported tail while holding the
append mutex.

Ordering rules that matter:

- The cursor is written **before** segments are unlinked. A crash in between costs a re-delete on
  the next boot; the other order strands a cursor pointing at bytes that are gone.
- Boot always opens a **fresh** segment, so "sealed" means "will never grow again". That is what
  lets a sealed segment be shipped or deleted without coordinating with the appender.
- A lost or unparseable cursor replays the lane from its oldest surviving segment. Everything here
  is **at-least-once**: replaying an exported frame is a duplicate row, skipping one is silent loss.
- Backlog is `committed - exported` bytes per lane, not anything derived from file sizes, so it
  stays exact across rotation and deletion. The shutdown drain and scale-in protection read it.

## The durability tier

Sealed segments are also shipped to S3 (`apps/ingest/src/wal_store.rs`), so a task that dies without
draining does not take its backlog with it.

```
s3://<bucket>/wal/v1/
  owners/<owner>                              ← heartbeat, refreshed every 60s
  claims/<owner>                              ← conditional-PUT claim marker
  segments/<owner>/shard-003-clickhouse/000000000041.seg
```

An **owner** is one boot, identified by a fresh UUID (never a task ARN), so a sequence number can
never be reused across boots and a claim can never race a live writer for the same key.

**Shipping.** A sealed segment is announced to a shipper task (`SEGMENT_SHIPPER_WORKERS`, one lane
always handled by the same worker so its events stay ordered). The shipper skips any segment the
exporter has already passed, which in a healthy pipeline is nearly all of them. That is why the
tier costs single-digit dollars a month at ~2B traces: the bucket holds the current backlog, not the
traffic. When a segment exports, its object is deleted.

**Claiming.** On boot, a task lists `owners/`, takes every owner whose heartbeat is older than
`INGEST_WAL_S3_ORPHAN_AFTER_SECS` (10 min), and claims it with a conditional `PUT … If-None-Match: *`.
S3 answers 412 when the key exists, so exactly one task wins without a lock service. The winner
lists that owner's segments and takes them **one at a time**: download, re-commit the frames to its
own lane, seal that lane and **re-ship it under its own owner id, and only then** delete the source
object, so the frames are never only on one task's disk. Memory holds one segment however large the
dead owner's backlog is. A segment that fails any step keeps its source object and the owner stays
claimable, so a later boot retries it (at-least-once); a failed re-commit or re-ship also stops that
owner's recovery, so the rest is not piled onto local disk only to be replayed again. The winner
re-stamps its claim every 5 minutes while that recovery runs. A claim older than 30 minutes is taken
over unconditionally, because the task that wrote it evidently died before finishing.

**Shipping gaps.** A full shipper channel drops a segment event rather than block an append. A lane
seals in sequence, so when a `Sealed` arrives past the one the shipper expected, it ships the skipped
segments too.

**Shutdown.** After `INGEST_SHUTDOWN_DRAIN_SECS`, whatever did not export is sealed and shipped, and
the owner heartbeat is deleted, so the next task claims it immediately instead of waiting out the
staleness window. Retiring stops the heartbeat first, so no late refresh can recreate the key.

Credentials come from the ECS task role (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, refreshed 5
minutes before expiry) unless `INGEST_WAL_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` are set. The VPC
has an S3 gateway endpoint and no NAT, so this traffic is free.

## Configuration

| Variable                          | Default                             | Notes                                                   |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `INGEST_QUEUE_MAX_BYTES`          | 20 GiB                              | Total WAL budget; divided evenly across lanes           |
| `INGEST_WAL_SHARDS`               | `max(cpus × 2, 2)`                  | Shards, not lanes: lanes are `shards × destinations`    |
| `INGEST_WAL_SEGMENT_MAX_BYTES`    | 8 MiB                               | Seal threshold, and so the shipped object size          |
| `INGEST_WAL_S3_BUCKET`            | unset                               | Unset keeps the WAL local-only (self-hosted, local dev) |
| `INGEST_WAL_S3_REGION`            | `$AWS_REGION`                       | Required with a bucket (either variable)                |
| `INGEST_WAL_S3_ENDPOINT`          | `https://s3.<region>.amazonaws.com` | For an S3-compatible target                             |
| `INGEST_WAL_S3_PREFIX`            | `wal`                               | Key prefix inside the bucket                            |
| `INGEST_WAL_S3_ORPHAN_AFTER_SECS` | 600                                 | How stale a heartbeat must be to be claimable           |
| `INGEST_WAL_S3_HEARTBEAT_SECS`    | 60                                  | Owner heartbeat interval                                |
| `INGEST_WAL_S3_TIMEOUT_MS`        | 10000                               | Per-request timeout                                     |
| `INGEST_SHUTDOWN_DRAIN_SECS`      | 90                                  | Must stay inside the task's 120s `stopTimeout`          |
| `INGEST_QUEUE_MAX_AGE_SECS`       | 300                                 | Age past which a queued frame is shed; 0 disables       |
| `INGEST_REQUEST_TIMEOUT_SECS`     | 30                                  | Gateway request deadline; 0 disables                    |

The bucket, its lifecycle rule (7-day expiry as a backstop for deletes that were lost) and the
task-role policy are in `apps/ingest/alchemy.run.ts`.

## What bounds the backlog

The byte caps bound how much the WAL holds, not how long a frame waits in it, and those are
different limits. A lane's channel holds `INGEST_QUEUE_CHANNEL_CAPACITY` frames (100k) and the WAL
holds `INGEST_QUEUE_MAX_BYTES` (20 GiB), so a stalled downstream target absorbs minutes of traffic
before either cap is reached. For all of those minutes the accept path queues behind it on the
WAL append rather than shedding, because `try_reserve_owned` only refuses once the slots are gone.
Two limits close that gap:

- **`INGEST_QUEUE_MAX_AGE_SECS`** sheds a frame the export worker picks up more than this long after
  it was committed. This is **deliberate data loss** and is metered as `ingest_queue_age_shed_total`
  (per org, destination and datasource). Alert on it. A shed frame still advances the lane cursor
  and releases its org bytes, or it would keep the backlog it was shed to cut. Frames recovered by
  WAL replay are stamped at replay time, so a restart's backlog gets a full window to export in
  rather than being shed on sight for having been written before the restart. Set to 0 to queue
  without an age bound.
- **An open ClickHouse target circuit breaker** defers the batch, with the lane cursor held, for
  one window: one breaker cooldown, at most 30s and at most a quarter of the max queue age. A
  target blip shorter than that is delivered without loss. Past the window that org's batch is
  shed as `shed_circuit_open` (metered as `circuit_open`) and the cursor advances, and later
  batches for the org shed at once until a probe succeeds. A probe that ends in a config-class drop
  (bad or blocked endpoint, redirect, 4xx) gives no verdict on the target: it frees the probe slot
  without closing the breaker or restarting its cooldown. One lane exports every org on its
  shard in turn, so the window is also the most a broken target delays the other orgs there:
  waiting longer would age their frames out instead.
- **`INGEST_REQUEST_TIMEOUT_SECS`** bounds one HTTP request. Without it the accept path had no
  deadline anywhere, so saturation did not surface as errors: requests queued on the WAL append and
  sat there, p95 in the tens of seconds with per-route error rates flat near zero. Timed-out
  requests answer 503 `@maple/ingest/RequestTimeout` with `Retry-After`, and are counted by
  `ingest_request_timeouts_total`.

`ingest_wal_append_duration_seconds` splits into `ingest_wal_lock_wait_duration_seconds` (the
append lock, held only for the write) and `ingest_wal_sync_wait_duration_seconds` (from the write to
the sync that covered it). `ingest_wal_fsync_duration_seconds` is recorded once per sync and
`ingest_wal_sync_batch_frames` says how many frames each sync covered, so their counts divided by
the append count is fsyncs per append. Sync wait near one fsync with batches above 1 is group commit
absorbing a slow device; sync wait well above two fsyncs means the device cannot keep up even
batched, and more lanes only redistribute the same IO. The `ingest.wal_commit` span carries the same
split as `maple.ingest.wal_lock_wait_ms`, `maple.ingest.wal_sync_wait_ms` and
`maple.ingest.wal_batch_frames`.

The gateway's resource attributes name its host: `host.id`, `host.type`, `host.image.id`,
`cloud.availability_zone` and `aws.ecs.task.arn` from the EC2 and ECS metadata endpoints, and
`maple.ingest.wal.device`, `.fs_type`, `.mount_point` and `.device_model` for the filesystem under
`INGEST_QUEUE_DIR`. A host whose fsync is slow can be told apart by AMI or by an instance-store
device that is not actually under the WAL.

## Metrics

| Metric                                  | Read it for                                                        |
| --------------------------------------- | ------------------------------------------------------------------ |
| `ingest_wal_shard_bytes`                | Bytes a lane holds on disk, exported prefix included               |
| `ingest_wal_shard_full_total`           | Appends rejected because a lane hit its cap: customer-visible 429s |
| `ingest_wal_segments_sealed_total`      | Segment rotation rate                                              |
| `ingest_wal_reclaimed_bytes_total`      | Bytes freed by deleting exported segments                          |
| `ingest_wal_shipped_bytes_total`        | Bytes that reached the bucket                                      |
| `ingest_wal_ship_outcomes_total`        | `outcome=exported_first` (healthy), `queue_full`, `failed`         |
| `ingest_wal_frames_recovered_total`     | Frames claimed from a dead task; non-zero means a task died dirty  |
| `ingest_wal_commit_bytes`               | Per-append size; the `ingest.wal_commit` span carries the latency  |
| `ingest_wal_sync_batch_frames`          | Frames per group-commit sync; its count is the fsync count         |
| `ingest_wal_sync_wait_duration_seconds` | Write to covering sync, per append                                 |

`queue_full` means the object store cannot keep up with segment rotation, and those segments stay
local-only. Sustained non-zero is the signal that the durability tier is not actually covering the
backlog.

## What is deliberately not here

A real stream (Kinesis, MSK, S2) buys ordered replay for multiple independent consumers. There is
one consumer, per-GB pricing hurts at trace volume, and MSK has a ~$500/month floor. Revisit only
when a second consumer or replay-as-a-feature is a requirement.

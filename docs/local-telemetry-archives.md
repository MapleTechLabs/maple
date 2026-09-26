# Local telemetry archives

Maple's embedded chDB store is a bounded **hot store**: it retains recent
telemetry (logs and traces for 30 days, metrics for 90 days) for fast local
querying. Local telemetry archives add **long-term, portable Parquet storage**
exported from immutable checkpoints. You query them with DuckDB, without
reloading history into the live store or running a second always-on database.

This is the operator and architecture guide for local archives: the model, the
happy path, the off-happy-path outcomes, querying, the fixed export tuning,
and the directory and manifest layouts.

## What archives are (and are not)

**Are:**

- Immutable Parquet exports of the six raw telemetry tables from a validated
  checkpoint.
- Sealed by fixed UTC day and signal, one generation at a time.
- Independently queryable with DuckDB; portable across machines.
- Crash-safe: an interrupted archive leaves the live store untouched and the
  archive in a recoverable state.

**Are not:**

- A live export endpoint. v1 archives are created explicitly by an operator.
- Automatic hot-store pruning. Existing chDB TTLs govern the hot store, and
  creating an archive does not delete from it. Removing an archived day from the
  live store is a separate, explicit `maple archive retire-live` step.
- Archive rehydration into the Maple UI. Historical data is queried in DuckDB,
  not reloaded into the dashboard.
- A second always-running database. Archives are files; DuckDB opens them on
  demand.

## The six signals

Archives export exactly the six **raw** telemetry tables. Aggregation and
materialized-view tables are excluded on purpose. They are rebuildable from raw
telemetry and would balloon archive volume without adding any fact the raw
tables lack.

| Signal (table / directory name) | Event-time column used for the UTC-day range |
| ------------------------------- | -------------------------------------------- |
| `logs`                          | `TimestampTime`                              |
| `traces`                        | `Timestamp`                                  |
| `metrics_sum`                   | `TimeUnix`                                   |
| `metrics_gauge`                 | `TimeUnix`                                   |
| `metrics_histogram`             | `TimeUnix`                                   |
| `metrics_exponential_histogram` | `TimeUnix`                                   |

Each signal uses a fixed half-open UTC-day range. The export queries implement it
with UTC `toDate(...) = <range-date>` and per-hour `toHour(...)` predicates,
equivalent to `eventTime >= start AND eventTime < end` for valid timestamps.

## Architecture

```text
Live Maple store (chDB)            Archive volume (operator-configured, SEPARATE from data/)
  data/                              <archiveDir>/
    backups/                           logs/
      state.json                         2026-06-01/
      snapshots/<checkpoint-id>/           active.json            ← atomic active pointer (formatVersion 1)
        backup/                            generations/<generation-id>/
        manifest.json                        manifest.json        ← generation manifest (formatVersion 3)
      pins/<checkpoint-id>/<pin-id>.json     shards/HH-NNNN.parquet  ← one or more shards per hour
      operations/active/                   catalog.jsonl          ← canonical rebuildable JSONL index
      quarantine/  (operation records)   traces/ ...
      retiring/                        building/<generation-id>/  (in-progress; owned temp output)
                                      quarantine/
                                        building-<operation-id>/ (retained pre-publication debris)
                                      operations/
                                        active/archive-<operation-id>/
                                          intent.json
                                          tombstones/<generation-id>/  (GC only)
                                        completed/archive-<operation-id>/
                                          intent.json
```

The archive volume is an operator-configured directory that **must be separate**
from the live data directory. The `assertArchiveRootSeparate` check refuses to
archive into (or beneath) the live store.

Beside the data directory (siblings, not children) live the restore and reset
transactions, the maintenance lock, `<data>.checkpoint-scratch/` (where a new
checkpoint is restored and validated; never `tmpdir()`, which is tmpfs on many
Linux hosts), `<data>.checkpoint-failures.json` (consecutive refresh failures),
and whatever a restore moved aside (see
[Checkpoint retention and leftovers](#checkpoint-retention-and-leftovers)).

### Why checkpoint-restored scratch, not a live copy

The only proven safe source for an archive is a native chDB checkpoint restored
into sacrificial scratch. A raw copy of the live data directory is unsafe: it
captures an inconsistent on-disk state, may include half-written merges, and
races concurrent ingest. A checkpoint is a validated, consistent snapshot.
Archive export restores one checkpoint into a private scratch chDB (the same
scoped instance that checkpoint validation uses), exports from it, then removes
the scratch. The live store is never opened for export.

As a consequence, archive export holds the **maintenance lock** so it cannot
overlap checkpoint creation, restore, or reset. The two operations share one
sacrificial chDB and must serialize.

### Why generations supersede instead of deduplicating by TraceId

There is no universal deduplication key across the six raw tables. `TraceId` is
shared by many spans, may be absent from logs, and does not exist on metrics. An
archive therefore seals a fixed UTC-day range into an immutable **generation**.
Late-arriving telemetry for an already-sealed day creates a **new generation**
that supersedes the old one. The `active.json` pointer atomically selects the
new generation. The old generation stays on disk but is never returned to
listings or queries. This avoids scanning all generations to dedup, and each
generation stays independently reproducible.

### Separation of logical chunks, physical shards, and row groups

Three distinct units, each bounded by a fixed tuning value:

- A **logical chunk** is a provisioning target (the `targetChunkBytes` tuning
  value), not a hard limit.
- A **physical shard** is one Parquet file, bounded by `maxShardRows` and
  `maxShardBytes`. In v1, each shard covers one UTC hour within the sealed day;
  if a single hour exceeds `maxShardBytes` uncompressed, it is recursively
  bisected at the physical `_part_offset` boundary. A single row that exceeds the
  byte bound is a distinct failure.
- A **Parquet row group** is the unit of compression and parallel decode inside a
  shard, sized by `rowGroupRows`.

## Pinning and the maintenance lock

Archive export holds Maple's **maintenance lock** so it cannot overlap checkpoint
creation, restore, or reset. Inside the lock, it acquires a **persistent pin**
on the source checkpoint so retention cannot delete the snapshot between
resolution and export. A stale pin (e.g. from a crashed archive that never
released it) over-retains data instead of risking deletion. The pin is
released after the generation is durable.

## Commands

`maple archive` has eight subcommands (`create`, `list`, `verify`, `rebuild`,
`reconcile`, `gc`, `retire-live`, `expire`). There are no short flags anywhere
in this command tree. Root flags fall back to `~/.maple` defaults when omitted.
Every subcommand prints JSON instead of its summary when the global
`--format json` is given.

| Flag             | Default            |
| ---------------- | ------------------ |
| `--data-dir`     | `~/.maple/data`    |
| `--archive-dir`  | `~/.maple/archive` |
| `--scratch-root` | `~/.maple/scratch` |

### `maple archive create <range-date> <signal>`

Seal one UTC day of one signal into a validated Parquet generation.

```sh
maple archive create 2026-06-01 traces \
  --data-dir ~/.maple/data \
  --archive-dir /Volumes/External/maple-archive \
  --scratch-root /Volumes/External/maple-scratch
```

- `<range-date>`: the UTC day to seal, as `YYYY-MM-DD` (validated; impossible
  calendar dates like `2026-02-31` are rejected).
- `<signal>`: one of the six signal names (positional, not a flag).
- `--checkpoint-id`: archive from a specific checkpoint instead of `current`.
- `--archive-dir` / `--scratch-root` / `--data-dir`: override the defaults.
- `--config`: ignored. It used to load a calibration config; it is still
  accepted so older scripts keep working, and `--debug` notes that it was
  ignored.
- `--allow-shrink`: let a generation with fewer rows than the active one
  supersede it.

The command resolves and pins the checkpoint, restores it to scratch, exports
bounded Parquet shards, validates row counts and checksums, publishes the
generation manifest, atomically selects it, canonically rebuilds the catalog,
releases the pin, and removes the owned scratch.

It refuses two exports that would lose data, after reconciling the aborted
operation so nothing is left for the next run:

- **A day past its retention.** Raw tables drop a whole UTC day at midnight
  `N` days after it (30 for logs and traces, 90 for metrics, or the configured
  floor). A day whose expiry is at or before the later of the checkpoint's
  creation and now may already be partial, so it is refused, first against the
  longest retention the store could have and again against the TTL the restored
  checkpoint carries. `--allow-shrink` does not bypass this.
- **A shrinking re-export.** A new generation with fewer rows than the active one
  is refused unless `--allow-shrink` is passed. Without this, re-exporting a day
  the live store had partly expired replaced the only full archive with a
  smaller one, and `archive gc` then deleted the full one.

### `maple archive list`

Report active generations:

```sh
maple archive list --archive-dir /Volumes/External/maple-archive
maple archive list --output paths --signal traces   # machine-readable paths
maple --format json archive list                    # full JSON
```

`--output` modes (`summary` is the default; only `list` has this flag):

- `summary`: one line per active generation: signal, range, rows, shards,
  short generation id.
- `paths`: a single comma-separated, double-quoted list of the active
  generation's Parquet shard paths (excluding superseded generations), ready for
  DuckDB's `read_parquet`. Requires `--signal`.
- `json`: deprecated alias of the global `--format json`: the full
  `listActiveGenerations` object, pretty-printed.

`list` verifies every shard's actual SHA-256 and byte size against the manifest
before returning it. A tampered shard fails closed: the affected range surfaces
in `errors`, and other ranges still list. Only the active generation is exposed.

### `maple archive verify`

Stream every active shard and check its SHA-256 with bounded memory. `--signal`
limits it to one signal. It prints the shard, generation and byte counts it
verified.

### `maple archive rebuild <signal>`

Rebuild a signal's `catalog.jsonl` from the authoritative generation manifests,
recovering from a truncated or missing catalog without rescanning Parquet bytes.
`<signal>` is positional.

### `maple archive retire-live <range-date> --apply`

Remove one sealed UTC day from all six live raw telemetry tables. The CLI first
reconciles interrupted archive work, then asks the running server to close
ingest/query admission, drain accepted requests, re-hash the frozen active
generation, and compare a canonical day-wide content digest as well as counts.
`--port` (default `4318`) names the running server.

The server durably commits the retired day and its archive evidence to
`<data-dir>.retired-days.json` before deleting any live row. That authority is
outside the replaceable chDB directory: startup repairs only retired dates that
actually reappeared before binding after a checkpoint restore. OTLP ingestion
filters retired rows while accepting current rows from the same request and
returns an OTLP partial-success response. Once any day is retired, arbitrary
SQL writes through `/local/query` are refused before execution, preventing
insert-trigger materialized views from retaining a late contribution.
A crash before the ledger commit leaves the live day intact; a crash after it is
repaired by replay. The default `--sealing-lag-hours 24` can be increased but
not bypassed by accident. The command refuses to run without `--apply`.

The command does not hard-code an active-data window. Scheduling policy chooses
which eligible day to retire (for example, the deployment may configure 60,
90, or 120 days). If the policy relies on database TTL as a backstop, configure
it independently with `maple start --minimum-raw-telemetry-retention-days N`.
That setting is durable beside the data directory, survives reset/restore, and
can only be increased; omitting it on later launches preserves the configured
value. Maple validates the live table TTLs before persisting the request and
never shortens a higher schema TTL. `N` must be between 90 and 3650 days. Keep it
strictly above the active rotation window so TTL cannot delete a day before
archival.

### `maple archive expire <range-date> --apply`

Delete one complete, already-retired archived UTC day across all six signals.
Maple first reconciles interrupted archive work, freezes the generation IDs,
re-hashes each generation before its destructive step, tombstone-renames each
signal range before removal, rebuilds each catalog, and journals progress at
`<archive-dir>/.retention/expire.json`. A rerun resumes only the exact frozen day
and generations. The command refuses to run without `--apply`.

### `maple archive reconcile`

Reconcile an interrupted `create` or `gc` operation to its intended state
**without a fresh export**. Flags: the three root flags plus `--dry-run`.

- `--dry-run`: report the decision and the archive root without mutating
  anything.
- Apply: execute the decision function's verdict.

The decision is one of: `NoOp` (nothing active), `FailClosed` (unsafe state:
zero mutation, exits non-zero), `CreateVerifyComplete`, `CreateAbortPrepublication`,
`CreateFinishPublication`, `GcVerifyComplete`, or `GcResume`. A subsequent
`create` also runs this reconciliation automatically as its first step.

### `maple archive gc`

Reclaim superseded archive generations, retaining the newest N per signal/range.
This is the **only** archive operation that deletes published generations, so,
like `expire` and `retire-live`, it only plans unless `--apply` is passed.

```sh
maple archive gc --keep 0                    # preview reclaiming all superseded
maple archive gc --archive-dir /Volumes/External/maple-archive --keep 1 --apply
```

- `--keep` (default `1`, `>= 0`): generations to retain per signal/range beyond
  the active one. `--keep 0` reclaims all superseded generations.
- `--apply`: delete the planned generations. Without it, and always with
  `--dry-run`, gc plans only and mutates nothing. If an operation is active in
  `operations/active/`, the plan reports the blocker and reclaims nothing.

GC is deliberately conservative. It verifies every generation's manifest and shard
checksums up front, excludes any signal/range whose catalog is not provably
reconstructable or whose active pointer is missing, deletes by tombstone-rename
(never in-place recursive delete), persists progress after every target, and
proves terminal invariants before retiring the journal.

## The happy path: fresh checkpoint through DuckDB investigation

1. Ingest telemetry into the running Maple store.
2. `maple checkpoint` to create a validated checkpoint.
3. `maple archive create 2026-06-01 traces` (and the other five signals).
4. `maple archive list --output paths --signal traces` to get the Parquet paths.
5. Query in DuckDB:

```sh
duckdb -c "SELECT ServiceName, count(*) FROM read_parquet(['/path/to/00.parquet', ...], union_by_name=true) GROUP BY ServiceName"
```

## DuckDB queries

Archives are portable Parquet. Use `read_parquet` with the active paths from
`maple archive list --output paths`. `union_by_name=true` NULL-fills columns
added between generations; without it, a schema mismatch fails closed.

```sql
-- Logs by service containing a keyword
SELECT ServiceName, min(Timestamp), max(Timestamp), count(*)
FROM read_parquet(<active_log_paths>, union_by_name=true)
WHERE Body ILIKE '%timeout%'
GROUP BY ServiceName;

-- Traces with p99 duration by service
SELECT ServiceName, count(*), quantile_cont(Duration, 0.99)
FROM read_parquet(<active_trace_paths>, union_by_name=true)
WHERE StatusCode = 'Error'
GROUP BY ServiceName;

-- Sum metric maxima
SELECT ServiceName, MetricName, max(Value)
FROM read_parquet(<active_metrics_sum_paths>, union_by_name=true)
GROUP BY ServiceName, MetricName;
```

### Memory limits and spill storage

For large archive ranges, constrain DuckDB's memory and direct spills to the
archive volume:

```sql
PRAGMA memory_limit='2GB';
PRAGMA temp_directory='/Volumes/External/duckdb-spill';
```

## Export tuning

Archive export uses one fixed set of values (`DEFAULT_ARCHIVE_TUNING` in
`apps/cli/src/server/archives/config.ts`): one writer thread, 10 000-row row
groups, and shards of at most 500 000 rows or 256 MiB uncompressed. There is no
per-deployment tuning.

### Values

| Field                 | Value                 | Used as                                                    |
| --------------------- | --------------------- | ---------------------------------------------------------- |
| `writerThreads`       | `1`                   | chDB `max_threads` for the Parquet writer                  |
| `rowGroupRows`        | `10000`               | `output_format_parquet_row_group_size`                     |
| `maxShardRows`        | `500000`              | row bound of one shard file                                |
| `maxShardBytes`       | `268435456` (256 MiB) | uncompressed byte bound of one shard file                  |
| `targetChunkBytes`    | `1073741824` (1 GiB)  | archive working-space estimate in the free-space preflight |
| `minFreeSpaceReserve` | `536870912` (512 MiB) | free space kept on the archive volume                      |

Every generation manifest records the effective tuning values (the six knobs
above), so a generation is reproducible and deployment drift is visible.

## Manifest, pointer, and catalog formats

### Generation manifest (`manifest.json`, formatVersion 3)

One per generation at
`<archiveDir>/<signal>/<range>/generations/<generationId>/manifest.json`. Fields:

| Field                                                | Type            | Notes                                                   |
| ---------------------------------------------------- | --------------- | ------------------------------------------------------- |
| `formatVersion`                                      | `3`             | Readers reject v2/v1 fail-closed (re-export to migrate) |
| `generationId`                                       | string (UUIDv4) |                                                         |
| `signal`                                             | string          |                                                         |
| `rangeStart`                                         | string          | `YYYY-MM-DD`                                            |
| `rangeEndExclusive`                                  | string          | ISO, the next UTC midnight                              |
| `checkpointId`                                       | string          | Source checkpoint                                       |
| `checkpointManifestFingerprint`                      | string          | `id:createdAt:backupBytes` of the source checkpoint     |
| `createdAt`                                          | string          | ISO                                                     |
| `mapleVersion` / `chdbVersion` / `schemaFingerprint` | string          |                                                         |
| `sourceRowCount` / `archivedRowCount`                | number          | Must be equal; `Σ shard.rowCount == archivedRowCount`   |
| `tuning`                                             | object          | The six effective knobs                                 |
| `tuningConfig`                                       | object \| null  | Always null now; older generations may name a config    |
| `shards`                                             | array           | One `ArchiveShardRecord` per shard                      |

Each `shard` entry: `name` (e.g. `00-0000.parquet`), `rowCount`,
`minEventTimeUnixNano` / `maxEventTimeUnixNano` (epoch-nanosecond decimal
strings), `sha256`, `bytes`, `columns`, `complexDigest`, and
`complexDigestAlgorithm`. Cross-field invariants (unique names, row-count sums,
source == archived) are enforced.

**Format-version history.** v1 used timezone-dependent time evidence and a
per-column-sum digest; v2 moved to UTC epoch-nanosecond strings and a multiset
digest but carried a bare `tuningConfigName`; **v3** replaces that with the
SHA-256-bound structured `tuningConfig` identity. v3 readers reject v2/v1
fail-closed and preserve the files. Older archives must be re-exported, not
migrated in place.

### Active pointer (`active.json`, formatVersion 1)

One per `<archiveDir>/<signal>/<range>/active.json`: `{ formatVersion: 1,
generationId, signal, rangeStart, selectedAt }`. The signal and range are bound
to the enclosing directory (mismatch fails closed). It is replaced atomically to
select a new generation.

### Catalog (`catalog.jsonl`)

One per signal at `<archiveDir>/<signal>/catalog.jsonl`. Each line is a JSON
object: `{ generationId, signal, rangeStart, checkpointId, archivedRowCount,
shardCount, createdAt, formatVersion: 1 }`. The catalog is a canonical,
rebuildable index: create, GC, and `archive rebuild` durably rewrite it from the
authoritative manifests. `assertCatalogExact` proves the result byte-for-byte
without rescanning Parquet.

## Recovery and reconciliation

Create and GC persist durable ownership/intent records **before** mutation and
retire them **only after** proving terminal state. Catalog rebuild uses a durable atomic rewrite rather than an
operation journal. A single pure decision function (`decideReconciliation`) is
the sole branch logic for create/GC recovery.

### The decision function

Given an inspection of the on-disk state, it returns one of:

- `NoOp`: nothing active.
- `FailClosed`: an unsafe/impossible topology (e.g. both building and final
  state present, a published generation with no manifest, a final generation
  before the manifest-written phase, an aborted operation still active). Zero
  mutation; exits non-zero.
- `CreateVerifyComplete`: a create reached `complete`; verify terminal
  invariants only.
- `CreateAbortPrepublication`: an interrupted create that had not published;
  move its owned building dir into retained quarantine, remove exact owned
  scratch, and release its exact pin.
- `CreateFinishPublication`: an interrupted create that **had** published;
  re-select the pointer and rebuild the catalog.
- `GcResume`: resume collecting a frozen GC target set.
- `GcVerifyComplete`: a GC reached `complete`; prove terminal invariants and
  retire the journal.

A phase label is never proof: the decision and the terminal checks re-read
reality from disk. Reconciliation runs inside the maintenance lock, and a
subsequent `create` runs it automatically as its first step, so most
interruptions heal without an explicit operator action.

### Leftover calibration state

Earlier releases had an `archive calibrate` command. Its interrupted runs could
leave a checkpoint pin with purpose `archive-calibrate:<operation-id>`, a
`<scratchRoot>/calibrate-<operation-id>` restore and `<archiveDir>/calibration/`.
Every applying reconcile (`create`, `gc --apply`, `reconcile`, `expire`,
`retire-live`) releases those pins and removes those directories under the
maintenance lock. It never fails the command; anything it cannot remove stays
over-retained and is reported under `--debug`.

### GC recovery

GC persists the **non-terminal** `gc-collecting` phase after every target
(including the last); `complete` is written only after catalog rebuild and
`assertCatalogExact`. Collection is by tombstone-rename (`generations/<id>` →
`operations/active/archive-<op>/tombstones/<id>`) then removal, never in-place
recursive delete. A read-only preflight classifies every frozen target into
**prefix** (already collected), **current** (the documented crash topologies),
and **suffix** (must still be untouched); an out-of-order suffix mutation is
`impossible` and fails closed. Resume finishes a half-removed tombstone or
idempotently confirms an already-absent target.

## Off-happy-path outcomes

| Outcome                                                 | What happens                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unavailable checkpoint**                              | `archive create` fails closed; the live store is untouched. No generation is written.                                                                                           |
| **Incompatible checkpoint** (wrong chDB/schema version) | The checkpoint resolver rejects it; no export runs.                                                                                                                             |
| **Stale pin**                                           | A crashed archive's pin over-retains the checkpoint snapshot safely. Re-running archive create succeeds; the pin from the failed run can be inspected under `backups/pins/`.    |
| **Interrupted restore**                                 | The restored scratch remains journal-owned until the next `create` or `archive reconcile` removes the exact owned path. The live store is never modified.                       |
| **Partial shard**                                       | Row limits are planned into separate shards and byte-overflow candidates are recursively bisected. Only one matching row that still exceeds `maxShardBytes` fails distinctly.   |
| **Validation mismatch** (source vs archived row count)  | The generation is not promoted. Reconciliation moves owned building output into retained quarantine, clears exact scratch/pin state, and leaves the active pointer unchanged.   |
| **Full or disconnected archive volume**                 | Free-space preflight fails before any export. No scratch is created.                                                                                                            |
| **Pointer or catalog corruption**                       | Summary mode omits malformed ranges; JSON exposes their errors, while paths mode fails closed for the requested signal. `archive rebuild` atomically replaces only the catalog. |
| **Late telemetry**                                      | A new generation supersedes; the old generation is retained but excluded from active paths.                                                                                     |
| **Shrinking re-export**                                 | Refused unless `--allow-shrink`; the aborted operation is reconciled at once and the active generation stays selected.                                                          |
| **Day past its retention**                              | Refused before any intent when even the longest possible retention has passed, otherwise once the restored checkpoint's TTL shows it; nothing is published.                      |
| **Supersession**                                        | Same as late telemetry: the newest generation becomes active; superseded ones remain on disk until `archive gc` reclaims them.                                                  |
| **Interrupted create**                                  | Reconciles automatically on the next `create`, or via `archive reconcile`. Pre-publication output moves to retained quarantine; post-publication repairs pointer and catalog.   |
| **Interrupted GC**                                      | Resumes the frozen target set; a half-removed tombstone is finished, an already-absent target is confirmed. Out-of-order mutation fails closed.                                 |
| **Interrupted live retirement**                         | Before ledger commit, all live rows remain. After commit, startup replays the authoritative retired day before binding and finishes exact UTC deletion.                         |
| **Interrupted archive expiration**                      | Resumes the frozen day and generation IDs; a tombstoned range is removed and its catalog rebuilt before progress advances.                                                      |

### What failures leave untouched vs. require action

- **Live store untouched by every archive failure.** Export reads only from
  restored scratch. GC never touches the live store either.
- **Recoverable or retained debris:** create reconciliation releases exact
  scratch/pin ownership but retains pre-publication building evidence under
  `quarantine/building-<operation-id>`. Unrelated stale pins are safely
  over-retained.
- **Requires reconciliation:** an interrupted `create` after publication
  (pointer/catalog may be inconsistent until reconcile re-selects/rebuilds) and
  an interrupted GC (frozen target set resumed).
- **Operator intervention:** a `FailClosed` reconciliation (impossible topology
  or suspected corruption), a persistently corrupt active pointer, or a shard
  that repeatedly exceeds bounds requires manual inspection.
  `archive reconcile --dry-run` reports the verdict without mutating.

## Checkpoint retention and leftovers

The registry keeps a rotating `current`/`previous` pair. Each new checkpoint is
restored into `<data>.checkpoint-scratch/`, counted, and reopened in a fresh
process (the same bar `maple restore` applies, since chDB reloads persisted
metadata only at process start) before it is published. Validation instances
stop TTL and ordinary merges, so counts compared across separate opens cannot
drift when a raw-table day expires at UTC midnight in between; migrations stop
TTL merges for the same reason.

After publishing, the old `previous` is retired, and so is every other snapshot
that is neither `current`, `previous` nor pinned and has a sound manifest. A
pinned checkpoint that rotated out is therefore reclaimed by the first refresh
after its pin is released. A refresh that fails leaves no store copy behind: the
incomplete snapshot is deleted and only its operation record goes to
`backups/quarantine/`. Consecutive failures are recorded in
`<data>.checkpoint-failures.json`, and the refresh loop waits the interval
doubled per failure, capped at the larger of the interval and four hours.

`maple reset`, `maple start --reset`, and `--on-dirty-store wipe` clear only the
engine-owned entries `control`, `data`, `metadata`, `status`, `store`, and `tmp`,
and first pin every sound checkpoint with purpose `reset-preserved:<operation>`.
Those pins keep the pre-reset checkpoints through any number of refreshes;
restore one with `maple restore --checkpoint-id <id> --yes`.

`maple restore` swaps the restored store in by rename and moves the old store to
the sibling `<data>.quarantine-<operation>-<quarantine>`. The registry is renamed
from the old store into the new one after the swap, so it is never copied.

Nothing moved aside is deleted automatically. `maple schema gc` lists it: stores
replaced by a restore, interrupted restores, stale maintenance locks, migration
rollback sources (`.maple-migrations/<id>/source`, with their old checkpoints),
abandoned migration targets and journals, checkpoint quarantine, and the
checkpoints a reset preserved. `--apply` deletes the leftovers under the
maintenance lock and refuses while a restore or reset is unfinished;
`--release-preserved` with `--apply` also releases the preservation pins and
retires what is no longer `current` or `previous`.

## Capacity and resource model

For a 4 GiB hot-store target, live store plus current and previous checkpoints is
roughly 3x the live footprint. Checkpoint creation, scratch restore, and archive
building can temporarily raise aggregate working storage toward 4 to 5x. That is
an aggregate across volumes, not a free-space requirement for one disk. A restore
needs room for one extra store (the restored copy) on the data directory's
volume; the checkpoint registry is moved, not copied.
Checkpoint validation and archive export share **one** sacrificial chDB, so
archive export does not add a second concurrent `f(4)` memory term.

The archive volume grows with retained historical ranges. Use volume-specific
free-space measurements in deployment. Create requires
`minFreeSpaceReserve + targetChunkBytes` on the archive filesystem. GC lets you
bound growth by reclaiming superseded generations.

> **Capacity caveat:** The fixed tuning values were measured on one macOS ARM64
> machine with one synthetic data distribution. CPU count, RAM, storage speed,
> row width, cardinality, and compression ratio vary, so measure free space on
> your own volumes.

## Non-goals (v1)

- No live export endpoint.
- No automatic hot-store pruning.
- No archive rehydration into the Maple UI.
- No always-running twin database.
- No automatic archive scheduling (start manual; add scheduling only after
  repeated successful runs and measured checkpoint pause).

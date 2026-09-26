# Maple Local event consumer protocol

Status: version 1 of the durable downstream-consumer boundary for the Maple Local event outbox.
Routes live in `apps/cli/src/server/serve.ts`; state lives in
`apps/cli/src/server/eventing/control-store.ts`.

This protocol lets a local consumer deliver ready Maple CloudEvents without destructive reads or a
second delivery database. It is transport-neutral. Maple does not pick a downstream transport, store
downstream credentials, or choose delivery destinations.

## Credentials

Maple creates two independent random 32-byte credentials (64 hex characters) beside the configured
data directory:

- `<dataDir>.maintenance-token` administers projection and consumer configuration.
- `<dataDir>.event-consumer-token` permits only claim and acknowledgement requests.

Both files must be regular files, not symlinks. The consumer token goes in
`x-maple-event-consumer-token`. It grants no access to projection configuration, outbox inspection,
checkpoints, or retention controls. The maintenance token goes in `x-maple-maintenance-token` and
cannot stand in for the consumer token. A wrong or missing consumer token returns `403`.

## Consumer administration

Consumer IDs match `^[a-z][a-z0-9._-]{0,63}$` and are unique. Disabled IDs stay reserved, so an
operator cannot accidentally hand one consumer's durable position to an unrelated process.

Register a consumer with the maintenance credential:

```http
POST /local/eventing/consumers
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation","startAt":"beginning"}
```

`startAt` takes one of two values:

- `beginning` starts immediately before the earliest ready event still retained for the tenant.
- `latest` atomically skips every ready event visible at registration and receives later events.

Registration returns `201` and the consumer record. Reusing an existing or disabled ID returns
`409`. `GET /local/eventing/consumers` lists records under maintenance authorization.

Disable a consumer explicitly:

```http
POST /local/eventing/consumers/disable
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation"}
```

Disabling clears any active lease and removes the cursor from the retention quorum. The record
stays, and the ID cannot be reused.

## Claim and acknowledgement

Claim 1 to 1,000 ready events with a lease of 5 to 300 seconds:

```http
POST /local/eventing/claims
Content-Type: application/json
X-Maple-Event-Consumer-Token: <consumer token>

{"consumerId":"automation","limit":100,"leaseSeconds":60}
```

A non-empty response has this shape:

```json
{
	"consumerId": "automation",
	"leaseToken": "<64 lowercase hexadecimal characters>",
	"leaseExpiresAt": "2026-08-13T16:01:00.000Z",
	"throughSequence": 42,
	"events": [
		{
			"sequence": 42,
			"event": {
				"specversion": "1.0",
				"id": "sha256:...",
				"type": "dev.maple.example.record.observed.v1"
			},
			"stagedAt": "2026-08-13T16:00:00.000Z",
			"readyAt": "2026-08-13T16:00:00.010Z"
		}
	]
}
```

The `event` member (abbreviated above) is the complete validated CloudEvent. An empty claim returns
null lease fields, a null `throughSequence`, and an empty `events` array. Maple stores only a SHA-256
hash of the lease token. A second claim while the lease is live returns `409`. At or after expiry, a claim
restarts after the last acknowledged sequence and issues a new lease token.

Once the downstream system has accepted every event in the batch, acknowledge the exact
`throughSequence` from the claim:

```http
POST /local/eventing/acks
Content-Type: application/json
X-Maple-Event-Consumer-Token: <consumer token>

{"consumerId":"automation","leaseToken":"<claim token>","throughSequence":42}
```

Partial, extended, expired, missing, and wrong-token acknowledgements return `409`. Success
returns:

```json
{ "consumerId": "automation", "acknowledgedThrough": 42, "prunedEvents": 0 }
```

Claims are at-least-once. If a consumer crashes after a downstream send and before
acknowledgement, the batch is re-delivered after lease expiry. Consumers must use the immutable
Maple CloudEvent `id` as the downstream idempotency key whenever the destination supports one.

## Retention, capacity, and checkpoints

Ready events can be pruned only up to the lowest acknowledged sequence among the tenant's active
consumers. By default Maple keeps the newest 1,000 otherwise-prunable ready events. Disabled
consumers do not block pruning. Consumer acknowledgement never prunes staged events. With no active
consumer, acknowledgement retention deletes nothing.

The outbox defaults to 10,000 events and 256 MiB of canonical event JSON. Transactional counters
enforce both caps without scanning every event on each ingest. If a new projected event does not fit,
Maple drops it and continues warehouse ingestion. Existing staged and ready events stay intact. The
OTLP response carries `x-maple-eventing-dropped` with the number of dropped projection attempts.
Health includes a durable `deliveryGap` with a generation, a cumulative dropped-event count, and the
last drop time. Repeated overflow retries can count the same source occurrence more than once. Treat
the count as a loss indicator, not a count of unique missing facts.

A consumer with an unaccepted gap gets HTTP `409` with a JSON body: `error`
(`@maple/cli/eventing/EventConsumerDeliveryGap`), `message`, `consumerId`, `generation`, and
`droppedEvents`. Existing leases can still be acknowledged. After investigating the gap, an operator
can accept the current generation for a consumer:

```http
POST /local/eventing/consumers/accept-gap
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation","generation":1}
```

A stale generation is rejected. Acceptance resumes delivery of retained events. It does not recover
missing events. A new `latest` consumer skips existing history, including earlier gaps. A
`beginning` consumer must accept any recorded gap before claiming.

To free stranded or unwanted events, inspect the outbox first, then abandon 1 to 1,000 distinct
event IDs:

```http
POST /local/eventing/outbox/abandon
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"eventIds":["sha256:..."]}
```

Abandonment drains admitted requests, checks that every ID belongs to this tenant, and atomically
deletes the selected staged or ready records. One missing ID rejects the whole batch. Abandonment
records another delivery gap and clears the tenant's leases, so no consumer can acknowledge a deleted
batch. Consumers must accept the new generation before claiming again. This operation discards
delivery history on purpose. Ordinary inspection and acknowledgement never abandon staged records.
Reconcile or replay source facts separately when needed.

The eventing control schema is version 1 (`LOCAL_CONTROL_SCHEMA_VERSION` in
`apps/cli/src/server/local-schema-version.ts`). Its DDL digest is recorded in
`LOCAL_CONTROL_SCHEMA_HISTORY` (`apps/cli/src/server/local-schema-history.ts`). Snapshot validation rejects staged source-backed rows
with missing or malformed fingerprints.

Consumer cursors and leases are in the same SQLite backup as projection and outbox state. Consumer
mutations pass through the server admission gate, so a checkpoint cannot capture a half-applied claim
or acknowledgement.

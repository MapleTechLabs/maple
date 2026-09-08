# Maple Local event consumer protocol

Status: version 1 durable downstream-consumer boundary for the Maple Local event outbox.

This protocol lets a local consumer deliver ready Maple CloudEvents without destructive reads or a
second delivery database. It is intentionally transport-neutral: Maple does not select a downstream
transport, store downstream credentials, or choose delivery destinations.

## Credentials

Maple creates two independent 32-byte hexadecimal credentials beside the configured data directory:

- `<dataDir>.maintenance-token` administers projection and consumer configuration.
- `<dataDir>.event-consumer-token` permits only claim and acknowledgement requests.

Both files must be real regular files. The consumer token is sent in
`x-maple-event-consumer-token`; it does not grant access to projection configuration, outbox
inspection, checkpoints, or retention controls. The existing maintenance token is sent in
`x-maple-maintenance-token` and cannot be substituted for the consumer token.

## Consumer administration

Consumer IDs match `^[a-z][a-z0-9._-]{0,63}$` and are unique. Disabled IDs remain reserved so an
operator cannot accidentally replace one consumer's durable position with an unrelated process.

Register a consumer with the maintenance credential:

```http
POST /local/eventing/consumers
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation","startAt":"beginning"}
```

`startAt` is exact:

- `beginning` starts immediately before the earliest ready event still retained for the tenant.
- `latest` atomically skips every ready event visible at registration and receives later events.

Successful registration returns `201` and the consumer record. Reusing any existing or disabled ID
returns `409`. `GET /local/eventing/consumers` lists records under maintenance authorization.

Disable a consumer explicitly:

```http
POST /local/eventing/consumers/disable
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation"}
```

Disabling clears any active lease and removes that cursor from the retention quorum. It does not
delete the audit record or permit the ID to be reused.

## Claim and acknowledgement

Claim between 1 and 1,000 ready events for a lease of 5 through 300 seconds:

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

The real `event` member is the complete validated CloudEvent. An empty claim returns null lease
fields and an empty event array. Only a SHA-256 hash of the lease token is stored. A second claim
while the lease is live returns `409`; at or after expiry it returns the same unacknowledged prefix,
possibly with a new token.

After every event in the claimed batch has been accepted by the downstream system, acknowledge the
exact `throughSequence` returned by the claim:

```http
POST /local/eventing/acks
Content-Type: application/json
X-Maple-Event-Consumer-Token: <consumer token>

{"consumerId":"automation","leaseToken":"<claim token>","throughSequence":42}
```

Partial, extended, expired, missing, and wrong-token acknowledgements return `409`. Success returns:

```json
{ "consumerId": "automation", "acknowledgedThrough": 42, "prunedEvents": 0 }
```

Claims are at-least-once. A consumer crash after a downstream send and before acknowledgement causes
re-delivery after lease expiry. A consumer must therefore use the immutable Maple CloudEvent `id` as
its downstream idempotency key whenever the destination supports one.

## Retention, capacity, and checkpoints

Ready events are eligible for pruning only through the lowest acknowledged sequence among all active
consumers for the tenant. Maple retains the newest 1,000 otherwise-prunable ready events by default.
Disabled consumers do not block pruning; staged events are never pruned by consumer acknowledgement.
If no consumer is active, acknowledgement retention performs no deletion.

The outbox defaults to 10,000 events and 256 MiB of canonical event JSON. Transactional counters enforce both caps without scanning every event for each ingest. If a new projection cannot fit, Maple drops that projection and continues warehouse ingestion. Existing staged and ready events remain intact. The OTLP response includes `x-maple-eventing-dropped` with the number of dropped projection attempts. Health includes a durable `deliveryGap` with a generation, cumulative dropped-event count, and last-drop time. Repeated overflow retries can count the same source occurrence more than once; this is a loss indicator, not a count of unique missing facts.

A consumer with an unaccepted gap receives HTTP 409 with the `EventConsumerDeliveryGap` error, current generation and dropped count. Existing leases can still be acknowledged. After investigating the gap, an operator may explicitly accept the current generation for a consumer:

```http
POST /local/eventing/consumers/accept-gap
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation","generation":1}
```

A stale generation is rejected. Acceptance resumes delivery of retained events; it does not recover missing events. A new `latest` consumer intentionally skips existing history, including previous gaps. A `beginning` consumer must accept any recorded gap before claiming.

To free stranded or unwanted events, inspect the outbox first, then explicitly abandon 1–1,000 distinct event IDs:

```http
POST /local/eventing/outbox/abandon
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"eventIds":["sha256:..."]}
```

Abandonment drains admitted requests, validates every ID belongs to this tenant, and atomically deletes the selected staged or ready records. Any missing ID rejects the entire batch. It records another delivery gap and clears tenant leases, so consumers cannot acknowledge a deleted batch. Consumers must accept the new generation before claiming again. This operation loses delivery history deliberately; ordinary inspection and acknowledgement never abandon staged records. Reconcile or replay source facts separately when needed.

The initial public eventing control schema is version 1. Unreleased development schemas are not supported by this build. Snapshot validation rejects staged source-backed rows with missing or malformed fingerprints. A deployment running an earlier development build must qualify a separate migration before using this public build; do not reset or relabel its database.

Consumer cursors and leases are part of the same SQLite backup as projection and outbox state.
Consumer mutations enter the server admission gate, so checkpoint exclusivity cannot capture a
half-applied claim or acknowledgement.

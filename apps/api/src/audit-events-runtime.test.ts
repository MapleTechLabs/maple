import { describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/primitives"
import { WarehouseUpstreamError } from "@maple/domain/http"
import { Effect, Layer, Schema, Array as Arr } from "effect"
import { processAuditEventsBatch } from "./audit-events-runtime"
import { makeWarehouseServiceStub } from "@/routes/v2/v2-test-support"
import { AuditLogEvent, encodeAuditLogEventSync } from "@maple/backend/services/audit/audit-event"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AuditTrailService } from "@maple/backend/services/audit-trail/AuditTrailService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_audit_consumer_test")
const OTHER_ORG = asOrgId("org_audit_consumer_other")

const event = (
	id: string,
	orgId: OrgId = ORG,
	what: { readonly action: string; readonly outcome: "allowed" | "denied" } = {
		action: "dashboard.created",
		outcome: "allowed",
	},
) =>
	encodeAuditLogEventSync(
		new AuditLogEvent({
			orgId,
			id: Schema.decodeSync(AuditLogEvent.fields.id)(id),
			actorType: "user",
			source: "dashboard",
			...what,
			occurredAtMs: 1_700_000_000_000,
		}),
	)

/** The consumer's `maxRetries`: the attempt past it is the last. */
const MAX_RETRIES = 5

/** One queue message, recording which terminal call the consumer made on it. */
const message = (body: unknown, attempts: number) => {
	const calls: string[] = []
	return {
		message: {
			body,
			attempts,
			ack: () => calls.push("ack"),
			retry: () => calls.push("retry"),
		},
		calls,
	}
}

const batchOf = (...messages: ReadonlyArray<{ readonly message: unknown }>) =>
	({ messages: Arr.map(messages, (entry) => entry.message) }) as never

/** The consumer's services over one warehouse stub: the trail writes through the same `ingest`. */
const withTrail = (stub: ReturnType<typeof makeWarehouseServiceStub>) =>
	Layer.effect(AuditTrailService, AuditTrailService.make).pipe(
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, stub)),
	)

/** A warehouse whose `ingest` is interrupted — a deploy tearing the isolate down. */
const interruptedWarehouse = withTrail(makeWarehouseServiceStub({ ingest: () => Effect.interrupt }))

/** A warehouse whose `ingest` dies rather than failing — an unexpected defect. */
const dyingWarehouse = withTrail(
	makeWarehouseServiceStub({
		ingest: () => Effect.die(new Error("ingest exploded")),
	}),
)

const AUDIT_LOG = "audit_log"
const AUDIT_TRAIL = "audit_trail_events"

/**
 * A warehouse whose `ingest` records each call, failing the ones to the `failing` datasources.
 * `trailCopy` makes the write to the audit trail die or be interrupted instead.
 */
const warehouse = (failing: ReadonlyArray<string> = [], trailCopy?: "dies" | "interrupted") => {
	const written: Array<{ orgId: string; datasource: string; rows: ReadonlyArray<unknown> }> = []
	const layer = withTrail(
		makeWarehouseServiceStub({
			ingest: (tenant, datasource, rows) =>
				datasource === AUDIT_TRAIL && trailCopy === "dies"
					? Effect.die(new Error("trail exploded"))
					: datasource === AUDIT_TRAIL && trailCopy === "interrupted"
						? Effect.interrupt
						: failing.includes(datasource)
							? Effect.fail(
									new WarehouseUpstreamError({
										message: "tinybird down",
										pipeName: datasource,
										cause: new Error("down"),
									}),
								)
							: Effect.sync(() => {
									written.push({ orgId: tenant.orgId, datasource, rows })
								}),
		}),
	)
	/** `[orgId, row count]` per write to one datasource, in a stable order. */
	const writesTo = (datasource: string) =>
		Arr.map(
			Arr.filter(written, (write) => write.datasource === datasource),
			(write) => [write.orgId, write.rows.length] as const,
		).sort()
	return { written, writesTo, layer }
}

describe("processAuditEventsBatch", () => {
	it.effect("writes well-formed events through ingest, one batch per org, and acks them", () =>
		Effect.gen(function* () {
			const store = warehouse()
			const first = message(event("11111111-1111-4111-8111-111111111111"), 1)
			const second = message(event("22222222-2222-4222-8222-222222222222"), 1)
			const other = message(event("33333333-3333-4333-8333-333333333333", OTHER_ORG), 1)
			yield* processAuditEventsBatch(batchOf(first, second, other), MAX_RETRIES).pipe(
				Effect.provide(store.layer),
			)

			expect(first.calls).toEqual(["ack"])
			expect(second.calls).toEqual(["ack"])
			expect(other.calls).toEqual(["ack"])
			expect(store.writesTo(AUDIT_LOG)).toEqual([
				[OTHER_ORG, 1],
				[ORG, 2],
			])
		}),
	)

	it.effect("copies changes and refusals to the audit trail, and leaves allowed reads out", () =>
		Effect.gen(function* () {
			const store = warehouse()
			const change = message(event("11111111-1111-4111-8111-111111111111"), 1)
			const read = message(
				event("22222222-2222-4222-8222-222222222222", ORG, {
					action: "telemetry.read",
					outcome: "allowed",
				}),
				1,
			)
			const refusedRead = message(
				event("33333333-3333-4333-8333-333333333333", ORG, {
					action: "telemetry.read",
					outcome: "denied",
				}),
				1,
			)
			yield* processAuditEventsBatch(batchOf(change, read, refusedRead), MAX_RETRIES).pipe(
				Effect.provide(store.layer),
			)

			expect(store.writesTo(AUDIT_LOG)).toEqual([[ORG, 3]])
			expect(store.writesTo(AUDIT_TRAIL)).toEqual([[ORG, 2]])
		}),
	)

	it.effect("writes nothing to the audit trail for a batch of allowed reads", () =>
		Effect.gen(function* () {
			const store = warehouse()
			const read = message(
				event("11111111-1111-4111-8111-111111111111", ORG, {
					action: "telemetry.read",
					outcome: "allowed",
				}),
				1,
			)
			yield* processAuditEventsBatch(batchOf(read), MAX_RETRIES).pipe(Effect.provide(store.layer))

			expect(read.calls).toEqual(["ack"])
			expect(store.writesTo(AUDIT_TRAIL)).toEqual([])
		}),
	)

	// `audit_log` is the record. A message retried because only its copy failed would be
	// rewritten there on every attempt and end in the DLQ for an entry that was stored.
	it.effect("acks an entry whose audit trail copy died", () =>
		Effect.gen(function* () {
			const store = warehouse([], "dies")
			const change = message(event("11111111-1111-4111-8111-111111111111"), 1)
			yield* processAuditEventsBatch(batchOf(change), MAX_RETRIES).pipe(Effect.provide(store.layer))

			expect(change.calls).toEqual(["ack"])
			expect(store.writesTo(AUDIT_LOG)).toEqual([[ORG, 1]])
		}),
	)

	// A deploy landing between the two writes: unacked, so the platform redelivers the entry.
	it.effect("leaves an entry unacked when its audit trail copy is interrupted", () =>
		Effect.gen(function* () {
			const store = warehouse([], "interrupted")
			const change = message(event("11111111-1111-4111-8111-111111111111"), 1)
			const exit = yield* processAuditEventsBatch(batchOf(change), MAX_RETRIES).pipe(
				Effect.provide(store.layer),
				Effect.exit,
			)

			expect(exit._tag).toBe("Failure")
			expect(change.calls).toEqual([])
		}),
	)

	it.effect("acks an entry whose audit trail copy failed", () =>
		Effect.gen(function* () {
			const store = warehouse([AUDIT_TRAIL])
			const change = message(event("11111111-1111-4111-8111-111111111111"), 1)
			yield* processAuditEventsBatch(batchOf(change), MAX_RETRIES).pipe(Effect.provide(store.layer))

			expect(change.calls).toEqual(["ack"])
			expect(store.writesTo(AUDIT_LOG)).toEqual([[ORG, 1]])
		}),
	)

	// Cloudflare routes a message to the DLQ only when the consumer retries it
	// past `max_retries`. Acking on the final attempt would discard the entry
	// instead, which is exactly the silent drop this branch exists to prevent.
	it.effect("retries a failed write on the final attempt so the message reaches the DLQ", () =>
		Effect.gen(function* () {
			const exhausted = message(event("44444444-4444-4444-8444-444444444444"), MAX_RETRIES + 1)
			yield* processAuditEventsBatch(batchOf(exhausted), MAX_RETRIES).pipe(
				Effect.provide(warehouse([AUDIT_LOG]).layer),
			)
			expect(exhausted.calls).toEqual(["retry"])
		}),
	)

	it.effect("retries every message of a failed org batch while attempts remain", () =>
		Effect.gen(function* () {
			const a = message(event("55555555-5555-4555-8555-555555555555"), 2)
			const b = message(event("66666666-6666-4666-8666-666666666666"), 2)
			yield* processAuditEventsBatch(batchOf(a, b), MAX_RETRIES).pipe(
				Effect.provide(warehouse([AUDIT_LOG]).layer),
			)
			expect(a.calls).toEqual(["retry"])
			expect(b.calls).toEqual(["retry"])
		}),
	)

	// A typed failure retries; so must a defect. Catching only the failure
	// channel would let an unexpected throw escape the consumer, and Cloudflare
	// treats a consumer that neither acked nor retried as a retry anyway — but
	// silently, with no log and no DLQ accounting.
	it.effect("retries when the write dies instead of failing", () =>
		Effect.gen(function* () {
			const defect = message(event("77777777-7777-4777-8777-777777777777"), 2)
			yield* processAuditEventsBatch(batchOf(defect), MAX_RETRIES).pipe(Effect.provide(dyingWarehouse))
			expect(defect.calls).toEqual(["retry"])
		}),
	)

	// Interruption is not a failed attempt. Counting it as one would spend the
	// message's retry budget — and eventually route it to the DLQ — for a deploy.
	// Unacked is enough: the platform redelivers.
	it.effect("does not count an interrupted batch as an attempt", () =>
		Effect.gen(function* () {
			const torn = message(event("88888888-8888-4888-8888-888888888888"), 2)
			const exit = yield* processAuditEventsBatch(batchOf(torn), MAX_RETRIES).pipe(
				Effect.provide(interruptedWarehouse),
				Effect.exit,
			)
			expect(exit._tag).toBe("Failure")
			expect(torn.calls).toEqual([])
		}),
	)

	// A message that cannot decode will never decode. Retrying only burns the
	// attempts that would otherwise carry a recoverable message to the DLQ.
	it.effect("acks a malformed message instead of retrying it forever", () =>
		Effect.gen(function* () {
			const store = warehouse()
			const malformed = message({ not: "an audit event" }, 1)
			const fine = message(event("77777777-7777-4777-8777-777777777777"), 1)
			yield* processAuditEventsBatch(batchOf(malformed, fine), MAX_RETRIES).pipe(
				Effect.provide(store.layer),
			)

			expect(malformed.calls).toEqual(["ack"])
			expect(fine.calls).toEqual(["ack"])
			expect(store.writesTo(AUDIT_LOG)).toEqual([[ORG, 1]])
		}),
	)
})

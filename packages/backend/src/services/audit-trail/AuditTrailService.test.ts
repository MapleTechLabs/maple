import { describe, expect, it } from "@effect/vitest"
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import { WarehouseUpstreamError } from "@maple/domain/http"
import { OrgId } from "@maple/primitives"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { auditTrailEventId } from "./audit-trail-row"
import { AuditTrailService } from "./AuditTrailService"

const ORG = Schema.decodeSync(OrgId)("org_trail_service")

const down = new WarehouseUpstreamError({
	message: "tinybird down",
	pipeName: "audit_trail_events",
	cause: new Error("down"),
})

/**
 * A warehouse that answers the listing with canned rows, keeps the SQL it was handed and the
 * rows `ingest` receives; `failing` makes both fail.
 */
const fakeWarehouse = (rows: ReadonlyArray<Record<string, unknown>> = [], failing = false) => {
	const sql: Array<string> = []
	const written: Array<Record<string, unknown>> = []
	const bestEffort: Array<boolean> = []
	const layer = Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			ingest: (_tenant, _datasource, batch, options) =>
				failing
					? Effect.fail(down)
					: Effect.sync(() => {
							bestEffort.push(options?.bestEffort === true)
							// SAFETY: every warehouse row is a record of column values.
							written.push(...(batch as ReadonlyArray<Record<string, unknown>>))
						}),
			compiledQuery: ((_tenant: unknown, compiled: unknown) =>
				Effect.gen(function* () {
					if (failing) return yield* down
					const query = Effect.isEffect(compiled) ? yield* compiled : compiled
					// SAFETY: the listing hands the stub a compiled query.
					const compiledQuery = query as CompiledQuery<unknown>
					sql.push(compiledQuery.sql)
					// Decode as the real executor does, so timestamps arrive as `DateTime.Utc`.
					return yield* compiledQuery.decodeRows(rows)
				})) as never,
		}),
	)
	return { sql, written, bestEffort, ingests: () => bestEffort.length, layer }
}

const withTrail = <A, E>(
	warehouse: ReturnType<typeof fakeWarehouse>,
	use: (trail: AuditTrailService["Service"]) => Effect.Effect<A, E>,
) =>
	Effect.flatMap(AuditTrailService, use).pipe(
		Effect.provide(
			Layer.effect(AuditTrailService, AuditTrailService.make).pipe(Layer.provide(warehouse.layer)),
		),
	)

const stored = (id: string, overrides: Partial<Record<string, unknown>> = {}) => ({
	id,
	occurredAt: "2026-08-29 09:12:00.412",
	ingestedAt: "2026-08-29 09:13:30.000",
	provider: "github",
	account: "acme",
	providerEventId: `evt_${id}`,
	actorType: "user",
	actorId: "octocat",
	actorName: "",
	actorEmail: "",
	action: "org.add_member",
	category: "membership",
	outcome: "success",
	targetType: "user",
	targetId: "hubot",
	targetName: "",
	originIp: "",
	originCountry: "",
	userAgent: "",
	raw: JSON.stringify({ action: "org.add_member" }),
	...overrides,
})

const ids = [Str.repeat(32)("c"), Str.repeat(32)("b"), Str.repeat(32)("a")] as const
const OCCURRED_AT_MS = Date.UTC(2026, 7, 29, 9, 12, 0, 412)

describe("AuditTrailService.list", () => {
	it.effect("returns a page and where the next one starts when more events exist", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse(Arr.map(ids, (id) => stored(id)))
			const page = yield* withTrail(warehouse, (trail) => trail.list(ORG, { limit: 2 }))

			expect(Arr.map(page.events, (event) => event.id)).toEqual([ids[0], ids[1]])
			expect(page.next).toEqual({ occurredAtMs: OCCURRED_AT_MS, id: ids[1] })
		}),
	)

	it.effect("has no next page when the events fit", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse([stored(ids[0]), stored(ids[1])])
			const page = yield* withTrail(warehouse, (trail) => trail.list(ORG, { limit: 2 }))

			expect(page.events).toHaveLength(2)
			expect(page.next).toBeNull()
		}),
	)

	// Two unmerged copies differ only in when they were stored; the first write is the one the
	// table will keep, so it is the one to show.
	it.effect("reads an event's copies oldest write first, so the kept one is the first write", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse([
				stored(ids[0], { ingestedAt: "2026-08-29 09:13:30.000" }),
				stored(ids[0], { ingestedAt: "2026-08-29 09:20:00.000" }),
			])
			const page = yield* withTrail(warehouse, (trail) => trail.list(ORG, { limit: 10 }))

			expect(warehouse.sql[0]).toContain("ORDER BY occurredAt DESC, id DESC, ingestedAt ASC")
			expect(Arr.map(page.events, (event) => event.ingestedAt)).toEqual([
				Date.UTC(2026, 7, 29, 9, 13, 30),
			])
		}),
	)

	it.effect("shows a redelivered event the table has not merged yet once", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse([stored(ids[0]), stored(ids[0]), stored(ids[1])])
			const page = yield* withTrail(warehouse, (trail) => trail.list(ORG, { limit: 10 }))

			expect(Arr.map(page.events, (event) => event.id)).toEqual([ids[0], ids[1]])
		}),
	)

	// Ending the list because the row past the page is a copy would hide whatever follows it.
	it.effect("still offers a next page when the row past the page is an unmerged copy", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse([stored(ids[0]), stored(ids[1]), stored(ids[1])])
			const page = yield* withTrail(warehouse, (trail) => trail.list(ORG, { limit: 2 }))

			expect(page.next).toEqual({ occurredAtMs: OCCURRED_AT_MS, id: ids[1] })
		}),
	)

	it.effect("reads '' as absent and a payload that is not a JSON object as no payload", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse([
				stored(ids[0]),
				stored(ids[1], { raw: "not json" }),
				stored(ids[2], { raw: "" }),
			])
			const page = yield* withTrail(warehouse, (trail) => trail.list(ORG, { limit: 10 }))

			expect(page.events[0]).toMatchObject({
				providerEventId: `evt_${ids[0]}`,
				actor: { type: "user", id: "octocat", name: null, email: null },
				target: { type: "user", id: "hubot", name: null },
				originIp: null,
				raw: { action: "org.add_member" },
			})
			expect(Arr.map(page.events, (event) => event.raw === null)).toEqual([false, true, true])
		}),
	)

	// The cursor is an equality on the sorting key: a bound that dropped the milliseconds would
	// skip every event sharing the boundary second.
	it.effect("continues from the cursor's exact millisecond", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse()
			yield* withTrail(warehouse, (trail) =>
				trail.list(ORG, { before: { occurredAtMs: OCCURRED_AT_MS, id: ids[1] }, limit: 2 }),
			)

			expect(warehouse.sql[0]).toContain("OccurredAt = '2026-08-29 09:12:00.412'")
			expect(warehouse.sql[0]).toContain(`Id < '${ids[1]}'`)
		}),
	)

	it.effect("matches an actor by id, by email, or by the alias the caller resolved", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse()
			yield* withTrail(warehouse, (trail) =>
				trail.list(ORG, { actor: "ada@acme.test", actorAlias: "user_ada", limit: 2 }),
			)

			expect(warehouse.sql[0]).toContain(
				"((audit_trail_events.ActorId = 'ada@acme.test' OR audit_trail_events.ActorEmail = 'ada@acme.test') OR audit_trail_events.ActorId = 'user_ada')",
			)
		}),
	)

	it.effect("fails with a persistence error when the warehouse is down", () =>
		Effect.gen(function* () {
			const error = yield* withTrail(fakeWarehouse([], true), (trail) =>
				trail.list(ORG, { limit: 2 }),
			).pipe(Effect.flip)

			expect(error._tag).toBe("@maple/http/audit-trail/AuditTrailPersistenceError")
		}),
	)
})

describe("AuditTrailService.write", () => {
	const event: AuditTrailEvent = {
		provider: "maple",
		providerEventId: "evt_1",
		occurredAtMs: 1_700_000_000_000,
		actor: { type: "user", id: "usr_1" },
		action: "member.added",
		category: "membership",
		outcome: "success",
	}

	it.effect("stores absent values as '' and the payload as JSON text, under the writing org", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse()
			yield* withTrail(warehouse, (trail) =>
				trail.write(ORG, [event, { ...event, providerEventId: "evt_2", raw: { id: "evt_2" } }]),
			)

			expect(warehouse.written).toMatchObject([
				{ OrgId: ORG, ProviderEventId: "evt_1", Account: "", ActorName: "", TargetType: "", Raw: "" },
				{ OrgId: ORG, ProviderEventId: "evt_2", Raw: '{"id":"evt_2"}' },
			])
		}),
	)

	// The table keeps the highest `Version`: the first write has to win, or a redelivery would
	// carry its later `IngestedAt` into a detection window the event already fired in.
	it.effect("writes a redelivered event to the same key with a lower version", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse()
			yield* withTrail(warehouse, (trail) =>
				Effect.gen(function* () {
					yield* trail.write(ORG, [event])
					yield* TestClock.adjust("5 minutes")
					yield* trail.write(ORG, [event])
				}),
			)
			const [first, redelivered] = warehouse.written

			expect(redelivered?.["Id"]).toBe(first?.["Id"])
			expect(Number(redelivered?.["Version"])).toBeLessThan(Number(first?.["Version"]))
		}),
	)

	it.effect("does not reach the warehouse for an empty batch", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse()
			yield* withTrail(warehouse, (trail) => trail.write(ORG, []))
			yield* withTrail(warehouse, (trail) => trail.write(ORG, [event]))

			expect(warehouse.ingests()).toBe(1)
		}),
	)

	// A caller that drops the events on failure asks for a Warn, not an Error span.
	it.effect("passes best effort through to the insert", () =>
		Effect.gen(function* () {
			const warehouse = fakeWarehouse()
			yield* withTrail(warehouse, (trail) => trail.write(ORG, [event], { bestEffort: true }))
			yield* withTrail(warehouse, (trail) => trail.write(ORG, [event]))

			expect(warehouse.bestEffort).toEqual([true, false])
		}),
	)

	it.effect("fails with a persistence error when the warehouse is down", () =>
		Effect.gen(function* () {
			const error = yield* withTrail(fakeWarehouse([], true), (trail) =>
				trail.write(ORG, [event]),
			).pipe(Effect.flip)

			expect(error._tag).toBe("@maple/http/audit-trail/AuditTrailPersistenceError")
		}),
	)
})

describe("auditTrailEventId", () => {
	// The ingest gateway derives the same key in Rust for the providers it writes; these
	// vectors are the contract between the two.
	it("is the first 32 hex characters of sha256 over provider, account and event id", () => {
		expect(auditTrailEventId({ provider: "maple", account: "acme", providerEventId: "evt_1" })).toBe(
			"1d19ea3d78217e97b45a7a9d28300146",
		)
		expect(auditTrailEventId({ provider: "maple", providerEventId: "evt_1" })).toBe(
			"851ca0eff076aad987a0192777b176cd",
		)
	})

	it("keys another account's event, and another event, to a different row", () => {
		const base = { provider: "maple", account: "team_1", providerEventId: "evt_1" } as const

		expect(auditTrailEventId({ ...base, account: "team_2" })).not.toBe(auditTrailEventId(base))
		expect(auditTrailEventId({ ...base, providerEventId: "evt_2" })).not.toBe(auditTrailEventId(base))
	})
})

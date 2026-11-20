import { afterEach, assert, describe, it } from "@effect/vitest"
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import { AuditTrailPersistenceError, OrgId, UserId } from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Option, Order, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuditTrailService } from "@maple/backend/services/audit-trail/AuditTrailService"
import { FleetAuditService, gapsAfter } from "./FleetAuditService"
import { FleetConnectionService } from "./FleetConnectionService"
import { type FakeFleet, type FakeFleetActivity, fakeFleetDeps, makeFakeFleet } from "./fleet/fake-fleet"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_fleet")
const USER = Schema.decodeSync(UserId)("user_fleet")

interface Trail {
	readonly written: Array<{ readonly orgId: string; readonly event: AuditTrailEvent }>
	failing: boolean
}

const fakeTrail = (trail: Trail) =>
	Layer.succeed(AuditTrailService, {
		write: (orgId, events) =>
			trail.failing
				? Effect.fail(new AuditTrailPersistenceError({ message: "warehouse down" }))
				: Effect.sync(() => {
						trail.written.push(...Arr.map(events, (event) => ({ orgId, event })))
					}),
		list: () => Effect.die("unused"),
		count: () => Effect.die("unused"),
		providerStats: () => Effect.die("unused"),
	})

const run = <A, E>(
	testDb: TestDb,
	world: FakeFleet,
	trail: Trail,
	effect: Effect.Effect<A, E, FleetAuditService | FleetConnectionService>,
) => {
	const deps = fakeFleetDeps(testDb, world)
	return effect.pipe(
		Effect.provide([
			Layer.effect(FleetAuditService, FleetAuditService.make).pipe(
				Layer.provide(Layer.merge(deps, fakeTrail(trail))),
			),
			Layer.effect(FleetConnectionService, FleetConnectionService.make).pipe(Layer.provide(deps)),
		]),
	)
}

const activityAt = (id: number, type = "edited_agent_options"): FakeFleetActivity => ({
	id,
	created_at: "2026-11-19T10:00:00Z",
	type,
	actor_id: 3,
	actor_full_name: "Jane Admin",
	actor_email: "jane@acme.test",
})

const connect = FleetConnectionService.use((service) =>
	service.connect(ORG, USER, { url: "https://fleet.example.com", token: "fleet-api-token-0123456789" }),
)
const pollAll = FleetAuditService.use((service) => service.pollAll)

const activityCalls = (world: FakeFleet) =>
	Arr.filter(world.fake.calls, (call) => call.path === "/api/v1/fleet/activities")

interface Row {
	readonly activity_cursor: number | null
	readonly last_error: string | null
	readonly auth_failed_at: string | null
	readonly last_success_at: string | null
}

const row = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Row>(
			testDb,
			"SELECT activity_cursor, last_error, auth_failed_at, last_success_at FROM fleet_connections WHERE org_id = 'org_fleet'",
		),
	)

describe("FleetAuditService", () => {
	it.effect("reads a week back first, then only what came after the cursor", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(1), activityAt(2, "wiped_host")] })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				const first = yield* pollAll
				assert.deepStrictEqual(first, { connections: 1, failedConnections: 0, events: 2 })
				const [firstRead] = activityCalls(world)
				assert.isNotNull(firstRead?.search.get("start_created_at"))
				assert.isNull(firstRead?.search.get("after"))
				assert.deepStrictEqual(
					Arr.map(trail.written, ({ orgId, event }) => [
						orgId,
						event.provider,
						event.providerEventId,
						event.account,
					]),
					[
						["org_fleet", "fleet", "fleet.example.com:1", "Acme Corp"],
						["org_fleet", "fleet", "fleet.example.com:2", "Acme Corp"],
					],
				)

				world.activities.push(activityAt(3))
				const second = yield* pollAll
				assert.strictEqual(second.events, 1)
				// The read reaches back past the cursor, but counts only what is new.
				assert.strictEqual(
					Option.getOrUndefined(Arr.last(activityCalls(world)))?.search.get("after"),
					"0",
				)
				assert.strictEqual((yield* row(testDb))?.activity_cursor, 3)
			}),
		)
	})

	it.effect("pages through a backlog, storing each page", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: Arr.makeBy(501, (index) => activityAt(index + 1)) })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				const result = yield* pollAll
				assert.strictEqual(result.events, 501)
				assert.lengthOf(activityCalls(world), 2)
				assert.strictEqual((yield* row(testDb))?.activity_cursor, 501)
			}),
		)
	})

	it.effect("keeps the cursor when the page could not be stored, and records why", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(1)] })
		const trail: Trail = { written: [], failing: true }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				const result = yield* pollAll
				assert.deepStrictEqual(result, { connections: 1, failedConnections: 1, events: 0 })
				const stored = yield* row(testDb)
				assert.isNull(stored?.activity_cursor)
				assert.include(stored?.last_error ?? "", "could not be stored")

				trail.failing = false
				assert.strictEqual((yield* pollAll).events, 1)
				const healed = yield* row(testDb)
				assert.isNull(healed?.last_error)
				assert.isNotNull(healed?.last_success_at)
			}),
		)
	})

	it.effect("stops polling a server that rejects the token until a new one is saved", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(1)] })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				world.status = 401
				assert.strictEqual((yield* pollAll).failedConnections, 1)
				assert.isNotNull((yield* row(testDb))?.auth_failed_at)

				const calls = world.fake.calls.length
				assert.strictEqual((yield* pollAll).connections, 0)
				assert.strictEqual(world.fake.calls.length, calls)

				world.status = null
				yield* connect
				assert.strictEqual((yield* pollAll).events, 1)
			}),
		)
	})

	it.effect("holds a server that asked Maple to slow down, then reads it again", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(1)] })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				world.status = 429
				assert.strictEqual((yield* pollAll).failedConnections, 1)
				assert.include((yield* row(testDb))?.last_error ?? "", "slow down")
				world.status = null
				// Still held: the next tick does not claim the row.
				assert.strictEqual((yield* pollAll).connections, 0)
				yield* TestClock.adjust(15 * 60_000)
				assert.strictEqual((yield* pollAll).events, 1)
			}),
		)
	})

	it.effect("catches an activity whose id committed after a higher one was read", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(10), activityAt(12)] })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				yield* pollAll
				// A quiet tick writes nothing again, so detections never count an event twice.
				const written = trail.written.length
				assert.strictEqual((yield* pollAll).events, 0)
				assert.strictEqual(trail.written.length, written)

				world.activities.push(activityAt(11, "wiped_host"))
				assert.strictEqual((yield* pollAll).events, 1)
				yield* pollAll
				assert.deepStrictEqual(
					Arr.map(
						Arr.filter(
							trail.written,
							({ event }) => event.providerEventId === "fleet.example.com:11",
						),
						({ event }) => event.action,
					),
					["wiped_host"],
				)
			}),
		)
	})

	it.effect("catches an id below the very first read's lowest, and names path-hosted servers apart", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(12)] })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* FleetConnectionService.use((service) =>
					service.connect(ORG, USER, {
						url: "https://tools.example.com/fleet",
						token: "fleet-api-token-0123456789",
					}),
				)
				yield* pollAll
				world.activities.push(activityAt(11, "wiped_host"))
				yield* pollAll
				assert.deepStrictEqual(
					Arr.map(trail.written, ({ event }) => event.providerEventId),
					["tools.example.com/fleet:12", "tools.example.com/fleet:11"],
				)
			}),
		)
	})

	it.effect("stops paging a server that ignores the cursor once nothing is new", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(1), activityAt(2)], ignoresAfter: true })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* pollAll).events, 2)
				const calls = activityCalls(world).length
				assert.strictEqual((yield* pollAll).events, 0)
				assert.strictEqual(activityCalls(world).length, calls + 1)
			}),
		)
	})
	it.effect("reads every id between the cursor and the newest page of a server that ignores it", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({
			activities: Arr.makeBy(1_200, (index) => activityAt(index + 1)),
			ignoresAfter: true,
		})
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				// 1 to 500 first, then 1,200 down to 501 over two newest-first pages: none skipped.
				assert.strictEqual((yield* pollAll).events, 1_200)
				const ids = new Set(Arr.map(trail.written, ({ event }) => event.providerEventId))
				assert.strictEqual(ids.size, 1_200)
			}),
		)
	})

	it.effect("keeps reading a server that ignores the cursor past a full page", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({
			activities: Arr.makeBy(600, (index) => activityAt(index + 1)),
			ignoresAfter: true,
		})
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				// The first page is the oldest 500; the server then answers from id 1 again, so the
				// rest is read newest first, back to the cursor.
				assert.strictEqual((yield* pollAll).events, 600)
				world.activities = Arr.appendAll(world.activities, [activityAt(601), activityAt(602)])
				assert.strictEqual((yield* pollAll).events, 2)
				const ids = Arr.map(trail.written, ({ event }) => event.providerEventId)
				assert.strictEqual(new Set(ids).size, ids.length)
			}),
		)
	})

	it.effect("starts the feed over when the org switches to another server", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ activities: [activityAt(1)] })
		const trail: Trail = { written: [], failing: false }
		return run(
			testDb,
			world,
			trail,
			Effect.gen(function* () {
				yield* connect
				yield* pollAll
				assert.strictEqual((yield* row(testDb))?.activity_cursor, 1)
				// The same server again keeps its place.
				yield* connect
				assert.strictEqual((yield* row(testDb))?.activity_cursor, 1)
				yield* FleetConnectionService.use((service) =>
					service.connect(ORG, USER, {
						url: "https://devices.example.com",
						token: "fleet-api-token-0123456789",
					}),
				)
				assert.isNull((yield* row(testDb))?.activity_cursor)
			}),
		)
	})

	describe("gapsAfter", () => {
		const ids = (...values: ReadonlyArray<number>) => Arr.map(values, (id) => ({ id }))

		it("never records an id below 1 on an early feed's first read", () => {
			assert.deepStrictEqual(Arr.fromIterable(gapsAfter(new Set(), ids(1), null, 1)), [])
			assert.deepStrictEqual(
				Arr.sort(Arr.fromIterable(gapsAfter(new Set(), ids(3), null, 3)), Order.Number),
				[1, 2],
			)
		})

		it("remembers ids skipped below the new cursor, and forgets them once filled", () => {
			const open = gapsAfter(new Set(), ids(10, 12, 15), 9, 15)
			assert.deepStrictEqual(Arr.fromIterable(open).sort(), [11, 13, 14])
			const after = gapsAfter(open, ids(13, 16), 15, 16)
			assert.deepStrictEqual(Arr.fromIterable(after).sort(), [11, 14])
		})

		it("on a first read, remembers the reach below its lowest id too", () => {
			const open = gapsAfter(new Set(), ids(12), null, 12)
			assert.isTrue(open.has(11))
			assert.isFalse(open.has(12))
		})

		it("drops gaps a read can no longer reach", () => {
			const open = gapsAfter(new Set([3]), ids(40), 30, 40)
			assert.isFalse(open.has(3))
		})
	})
})

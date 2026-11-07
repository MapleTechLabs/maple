import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { OrgId, UserId, WorldEntityId, type WorldEntity, type WorldOp } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { ServiceMapWorldService } from "./ServiceMapWorldService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_world")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_world_other")
const USER = Schema.decodeSync(UserId)("user_world")
const API = WorldEntityId.make("svc:api")
const DB = WorldEntityId.make("svc:db")

const building = (nodeId: string, x: number): WorldEntity => ({
	_tag: "ServiceBuilding",
	nodeId,
	cell: { x, z: 0 },
	rotation: 0,
	building: null,
})

const put = (id: WorldEntityId, x: number, expectedRevision: number | null = null): WorldOp => ({
	_tag: "Put",
	id,
	entity: building(Str.slice(4)(id), x),
	expectedRevision,
})

const remove = (id: WorldEntityId, expectedRevision: number | null = null): WorldOp => ({
	_tag: "Remove",
	id,
	expectedRevision,
})

const withService = <A, E>(run: (testDb: TestDb) => Effect.Effect<A, E, ServiceMapWorldService>) => {
	const testDb = createTestDb(trackedDbs)
	return run(testDb).pipe(Effect.provide(ServiceMapWorldService.layer.pipe(Layer.provide(testDb.layer))))
}

const summary = (records: ReadonlyArray<{ readonly id: string; readonly revision: number }>) =>
	Arr.map(records, (record) => `${record.id}@${record.revision}`)

describe("ServiceMapWorldService", () => {
	it.effect("an org with no rows has an empty world", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				const doc = yield* world.get(ORG)
				assert.strictEqual(doc.schemaVersion, 1)
				assert.deepStrictEqual(doc.entities, [])
			}),
		),
	)

	it.effect("a put creates revision 1 and each later put bumps it", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				const first = yield* world.apply(ORG, USER, [put(API, 1)])
				assert.deepStrictEqual(summary(first.put), ["svc:api@1"])
				assert.strictEqual(first.put[0]?.updatedBy, USER)

				const second = yield* world.apply(ORG, USER, [put(API, 4, 1)])
				assert.deepStrictEqual(summary(second.put), ["svc:api@2"])

				const blind = yield* world.apply(ORG, USER, [put(API, 7)])
				assert.deepStrictEqual(summary(blind.put), ["svc:api@3"])

				const doc = yield* world.get(ORG)
				assert.deepStrictEqual(summary(doc.entities), ["svc:api@3"])
				assert.deepStrictEqual(doc.entities[0]?.entity, building("api", 7))
			}),
		),
	)

	it.effect("a stale revision fails the whole batch and writes nothing", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				yield* world.apply(ORG, USER, [put(API, 1)])
				yield* world.apply(ORG, USER, [put(API, 2, 1)])

				const error = yield* world.apply(ORG, USER, [put(DB, 5), put(API, 9, 1)]).pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/service-map-world/WorldConflictError")
				if (error._tag === "@maple/http/service-map-world/WorldConflictError") {
					assert.deepStrictEqual(error.ids, [API])
					assert.deepStrictEqual(summary(error.current), ["svc:api@2"])
				}

				const doc = yield* world.get(ORG)
				assert.deepStrictEqual(summary(doc.entities), ["svc:api@2"])
				assert.deepStrictEqual(doc.entities[0]?.entity, building("api", 2))
			}),
		),
	)

	it.effect("expecting a revision of a row that does not exist is a conflict", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				const error = yield* world.apply(ORG, USER, [put(API, 1, 3)]).pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/service-map-world/WorldConflictError")
				if (error._tag === "@maple/http/service-map-world/WorldConflictError") {
					assert.deepStrictEqual(error.current, [])
				}
				assert.deepStrictEqual((yield* world.get(ORG)).entities, [])
			}),
		),
	)

	it.effect("remove deletes the row, checked against its revision", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				yield* world.apply(ORG, USER, [put(API, 1), put(DB, 2)])
				const stale = yield* world.apply(ORG, USER, [remove(API, 2)]).pipe(Effect.flip)
				assert.strictEqual(stale._tag, "@maple/http/service-map-world/WorldConflictError")

				const result = yield* world.apply(ORG, USER, [remove(API, 1)])
				assert.deepStrictEqual(result.removed, [API])
				assert.deepStrictEqual(summary((yield* world.get(ORG)).entities), ["svc:db@1"])
			}),
		),
	)

	it.effect("a batch that names an entity twice is rejected", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				const error = yield* world.apply(ORG, USER, [put(API, 1), remove(API)]).pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/service-map-world/WorldInvalidOpsError")
				assert.deepStrictEqual((yield* world.get(ORG)).entities, [])
			}),
		),
	)

	it.effect("each org sees and edits only its own world", () =>
		withService(() =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				yield* world.apply(ORG, USER, [put(API, 1)])
				const other = yield* world.apply(OTHER_ORG, USER, [put(API, 9)])
				assert.deepStrictEqual(summary(other.put), ["svc:api@1"])
				yield* world.apply(OTHER_ORG, USER, [remove(API)])

				const doc = yield* world.get(ORG)
				assert.deepStrictEqual(summary(doc.entities), ["svc:api@1"])
				assert.deepStrictEqual(doc.entities[0]?.entity, building("api", 1))
				assert.deepStrictEqual((yield* world.get(OTHER_ORG)).entities, [])
			}),
		),
	)

	it.effect("a stored row of an unknown kind is skipped, not fatal", () =>
		withService((testDb) =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				yield* world.apply(ORG, USER, [put(API, 1)])
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`INSERT INTO service_map_world_entities
							(org_id, entity_id, kind, data, revision, created_at, updated_at, updated_by)
						VALUES ($1, 'dec:tree', 'Decoration', '{"_tag":"Decoration","sprite":"tree"}', 1, now(), now(), NULL)`,
						[ORG],
					),
				)
				assert.deepStrictEqual(summary((yield* world.get(ORG)).entities), ["svc:api@1"])
			}),
		),
	)

	it.effect("a batch that would grow the world past its cap is rejected", () =>
		withService((testDb) =>
			Effect.gen(function* () {
				const world = yield* ServiceMapWorldService
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`INSERT INTO service_map_world_entities
							(org_id, entity_id, kind, data, revision, created_at, updated_at, updated_by)
						SELECT $1, 'svc:n' || i, 'ServiceBuilding', '{}', 1, now(), now(), NULL
						FROM generate_series(1, 5000) AS i`,
						[ORG],
					),
				)
				const error = yield* world.apply(ORG, USER, [put(API, 1)]).pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/service-map-world/WorldInvalidOpsError")
				// Replacing an entity that exists does not grow the world.
				const replaced = yield* world.apply(ORG, USER, [put(WorldEntityId.make("svc:n1"), 3)])
				assert.deepStrictEqual(summary(replaced.put), ["svc:n1@2"])
			}),
		),
	)
})

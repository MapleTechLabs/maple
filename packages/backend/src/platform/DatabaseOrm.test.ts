import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ApiKeys } from "@maple/db/tables"
import { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema, Tracer } from "effect"
import { Database, DatabaseError } from "./DatabaseLive"
import { postgresErrorType, postgresSqlState } from "./postgres-errors"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"

// effect-orm through Maple's `Database.execute`: one span per call, statement
// capture, transactions and error absorption.

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const org = Schema.decodeSync(OrgId)("org_orm")
const user = Schema.decodeSync(UserId)("user_orm")
const keyId = (n: number) => Schema.decodeSync(ApiKeyId)(`00000000-0000-4000-8000-00000000000${n}`)

const key = (n: number) =>
	PG.insertInto(ApiKeys).values({
		id: keyId(n),
		orgId: org,
		name: `key ${n}`,
		keyHash: `hash_${n}`,
		keyPrefix: "maple_",
		createdAt: 1_700_000_000_000 + n,
		createdBy: user,
	})

class Abort extends Schema.TaggedError<Abort>()("@maple/test/Abort", { message: Schema.String }) {}

describe("effect-orm through Database.execute", () => {
	it.effect("runs builder queries and records their SQL on the call's span", () =>
		Effect.gen(function* () {
			const spans: Array<Tracer.NativeSpan> = []
			const tracer = Tracer.make({
				span(options) {
					const span = new Tracer.NativeSpan(options)
					spans.push(span)
					return span
				},
			})
			const database = yield* Database
			yield* database.execute((db) => db.run(key(1)))
			const rows = yield* database
				.execute((db) =>
					db.run(
						PG.from(ApiKeys)
							.select()
							.where(($) => [$.orgId.eq(PG.param.of(ApiKeys.columns.orgId, "orgId"))]),
						{ orgId: org },
					),
				)
				.pipe(Effect.withTracer(tracer))

			assert.strictEqual(rows.length, 1)
			assert.strictEqual(rows[0]!.createdAt, 1_700_000_000_001)
			assert.strictEqual(rows[0]!.kind, "standard")
			assert.strictEqual(rows[0]!.revoked, false)
			const span = spans.find((s) => s.attributes.get("db.system.name") === "postgresql")
			assert.isDefined(span)
			assert.strictEqual(span.name, "SELECT api_keys")
			assert.include(span.attributes.get("db.query.text") as string, `"org_id" = $1`)
			assert.notInclude(span.attributes.get("db.query.text") as string, "org_orm")
			assert.strictEqual(span.attributes.get("result.rowCount"), 1)
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("rolls a failed nested transaction back to its savepoint and keeps the outer one", () =>
		Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.run(key(1))
						const inner = yield* db
							.transaction(
								Effect.andThen(db.run(key(2)), Effect.fail(new Abort({ message: "inner" }))),
							)
							.pipe(Effect.flip)
						assert.instanceOf(inner, Abort)
					}),
				),
			)
			const left = yield* database.execute((db) => db.run(PG.from(ApiKeys).select("id")))
			assert.deepStrictEqual(
				left.map((row) => row.id),
				[keyId(1)],
			)
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("rolls back its own transaction and keeps the callback's error", () =>
		Effect.gen(function* () {
			const database = yield* Database
			const error = yield* database
				.execute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(key(3))
							return yield* new Abort({ message: "roll back" })
						}),
					),
				)
				.pipe(Effect.flip)
			assert.instanceOf(error, Abort)
			const left = yield* database.execute((db) => db.run(PG.from(ApiKeys).select("id")))
			assert.deepStrictEqual(left, [])
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("absorbs a constraint violation into DatabaseError with its SQLSTATE", () =>
		Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) => db.run(key(4)))
			const error = yield* database.execute((db) => db.run(key(4))).pipe(Effect.flip)
			assert.instanceOf(error, DatabaseError)
			assert.include(error.message, "duplicate key")
			assert.include(error.message, `INSERT INTO "api_keys"`)
			assert.strictEqual(postgresSqlState(error), "23505")
			assert.strictEqual(postgresErrorType(error), "23505")
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)
})

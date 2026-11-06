import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Schema } from "effect"
import { Investigations } from "@maple/db/tables"
import {
	InvestigationFreeformSubject,
	InvestigationId,
	type InvestigationStatus,
	OrgId,
} from "@maple/domain/http"
import { Database } from "./DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"
import { transitionRow } from "./transition-row"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_transition_row_test")
const ID = Schema.decodeUnknownSync(InvestigationId)("00000000-0000-4000-8000-000000000001")
const NOW = Date.UTC(2026, 10, 6, 12, 0)

const seed = Effect.gen(function* () {
	const database = yield* Database
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(Investigations).values({
				id: ID,
				orgId: ORG,
				status: "investigating",
				seededBy: "system",
				subjectJson: new InvestigationFreeformSubject({
					type: "freeform",
					title: "seed",
					prompt: "seed",
					contextRefs: [],
				}),
				createdAt: NOW,
				updatedAt: NOW,
			}),
		),
	)
})

const move = (from: InvestigationStatus, to: InvestigationStatus) =>
	Effect.gen(function* () {
		const database = yield* Database
		return yield* database.execute((db) =>
			transitionRow({ table: "investigations", id: ID, from: [from], to }, (expected) =>
				db.run(
					PG.update(Investigations)
						.set({ status: to, updatedAt: NOW })
						.where(($) => [$.orgId.eq(ORG), $.id.eq(ID), $.status.in_(...expected)])
						.returning("id", "status"),
				),
			),
		)
	})

const statusNow = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db.run(PG.from(Investigations).select("status").where(($) => [$.orgId.eq(ORG), $.id.eq(ID)])),
	)
	return rows[0]?.status
})

describe("transitionRow", () => {
	it.effect("returns the transitioned row when the state still matches", () =>
		Effect.gen(function* () {
			yield* seed
			const row = yield* move("investigating", "diagnosed")
			assert.strictEqual(row.status, "diagnosed")
		}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
	)

	it.effect("fails the writer that read a state another writer already moved", () =>
		Effect.gen(function* () {
			yield* seed
			// Both writers read `investigating`; the first commits, the second must not overwrite it.
			yield* move("investigating", "failed")
			const conflict = yield* Effect.flip(move("investigating", "diagnosed"))

			assert.strictEqual(conflict._tag, "@maple/backend/TransitionConflictError")
			assert.deepStrictEqual(conflict.expected, ["investigating"])
			assert.strictEqual(conflict.target, "diagnosed")
			assert.strictEqual(yield* statusNow, "failed")
		}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
	)
})

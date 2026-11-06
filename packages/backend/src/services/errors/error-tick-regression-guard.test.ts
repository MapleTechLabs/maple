import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Schema } from "effect"
import { ErrorIssues } from "@maple/db/tables"
import { ErrorIssueId, OrgId } from "@maple/domain/primitives"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { applyRegressions } from "./error-tick-persistence"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_error_tick_regression_guard")
const DONE = Schema.decodeSync(ErrorIssueId)("00000000-0000-4000-8000-0000000000d1")
const CANCELLED = Schema.decodeSync(ErrorIssueId)("00000000-0000-4000-8000-0000000000c1")
const SNOOZED = Schema.decodeSync(ErrorIssueId)("00000000-0000-4000-8000-0000000000e1")
const WOKEN = Schema.decodeSync(ErrorIssueId)("00000000-0000-4000-8000-0000000000f1")
const NOW = Date.UTC(2026, 10, 6, 12, 0)

const seed = (
	id: ErrorIssueId,
	workflowState: "done" | "cancelled" | "wontfix",
	snoozeUntil: number | null = null,
) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(ErrorIssues).values({
					id,
					orgId: ORG,
					fingerprintHash: `fp-${id}`,
					serviceName: "checkout-api",
					exceptionType: "TimeoutError",
					exceptionMessage: "upstream timed out",
					topFrame: "handler.ts:42",
					workflowState,
					snoozeUntil,
					resolvedAt: workflowState === "done" ? NOW - 60_000 : null,
					firstSeenAt: NOW,
					lastSeenAt: NOW,
					createdAt: NOW,
					updatedAt: NOW,
				}),
			),
		)
	})

describe("applyRegressions", () => {
	it.effect("reopens a done issue but not one a human cancelled after the scan read it", () =>
		Effect.gen(function* () {
			yield* seed(DONE, "done")
			// The scan saw both as `done`; a person cancelled this one before the tick wrote.
			yield* seed(CANCELLED, "cancelled")
			const database = yield* Database

			const { reopened, stillSuppressed } = yield* database.execute((db) =>
				applyRegressions(db, { orgId: ORG, windowEndMs: NOW }, [DONE, CANCELLED]),
			)
			assert.deepStrictEqual([...reopened], [DONE])
			// A cancelled issue takes the occurrence as an ordinary one.
			assert.deepStrictEqual([...stillSuppressed], [])

			const rows = yield* database.execute((db) =>
				db.run(
					PG.from(ErrorIssues)
						.select("id", "workflowState", "regressionCount", "resolvedAt")
						.where(($) => [$.orgId.eq(ORG)])
						.orderBy(["id", "asc"]),
				),
			)
			assert.deepStrictEqual(rows, [
				{ id: CANCELLED, workflowState: "cancelled", regressionCount: 0, resolvedAt: null },
				{ id: DONE, workflowState: "regressed", regressionCount: 1, resolvedAt: null },
			])
		}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
	)

	it.effect("keeps a lost reopen suppressed when the issue moved to an active wontfix snooze", () =>
		Effect.gen(function* () {
			// The scan saw both as `done`; one was snoozed as wontfix, the other's snooze elapsed.
			yield* seed(SNOOZED, "wontfix", NOW + 3_600_000)
			yield* seed(WOKEN, "wontfix", NOW - 1)
			const database = yield* Database

			const { reopened, stillSuppressed } = yield* database.execute((db) =>
				applyRegressions(db, { orgId: ORG, windowEndMs: NOW }, [SNOOZED, WOKEN]),
			)
			assert.deepStrictEqual([...reopened], [])
			assert.deepStrictEqual([...stillSuppressed], [SNOOZED])
		}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
	)
})

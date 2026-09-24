/**
 * When a run that still says `investigating` counts as abandoned.
 *
 * The heartbeat clause is the whole point of these: a pass gets ten minutes and its close-out is a
 * second run with its own ten, so a run doing exactly what it should outlives `STALE_MS`. Before
 * the sweep existed that only mattered when something happened to read the row; running every tick
 * turned it into a race a live run could lose.
 */
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { investigations } from "@maple/db"
import { InvestigationId, OrgId } from "@maple/domain/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	isInvestigationStale,
	PROGRESS_HEARTBEAT_STALE_MS,
	STALE_MS,
	sweepAbandonedInvestigations,
} from "./investigation-stale"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => createTestDb(createdDbs).layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const ORG = asOrgId("org_investigation_stale_test")

const NOW = Date.UTC(2026, 8, 20, 12, 0)
const startedAgo = (ms: number) => new Date(NOW - ms)

const row = (input: { status?: string; startedMsAgo?: number; heartbeatMsAgo?: number | null }) => ({
	status: input.status ?? "investigating",
	startedAt: startedAgo(input.startedMsAgo ?? STALE_MS + 60_000),
	progressJson:
		input.heartbeatMsAgo === undefined || input.heartbeatMsAgo === null
			? null
			: { updatedAt: NOW - input.heartbeatMsAgo },
})

describe("isInvestigationStale", () => {
	it("fails a run past the budget that never reported a step", () => {
		expect(isInvestigationStale(row({}), NOW)).toBe(true)
	})

	it("leaves a run inside the budget alone", () => {
		expect(isInvestigationStale(row({ startedMsAgo: STALE_MS - 60_000 }), NOW)).toBe(false)
	})

	/** The race the tick sweep introduced: a pass in its close-out is past 15 minutes and alive. */
	it("spares a run past the budget that is still recording steps", () => {
		expect(isInvestigationStale(row({ startedMsAgo: 18 * 60_000, heartbeatMsAgo: 8_000 }), NOW)).toBe(
			false,
		)
	})

	it("fails it once the steps stop", () => {
		expect(
			isInvestigationStale(
				row({ startedMsAgo: 30 * 60_000, heartbeatMsAgo: PROGRESS_HEARTBEAT_STALE_MS + 1_000 }),
				NOW,
			),
		).toBe(true)
	})

	/** Being generous with the heartbeat cannot strand a row: the budget floor is crossed first. */
	it("still requires the budget to have been spent", () => {
		expect(isInvestigationStale(row({ startedMsAgo: 60_000, heartbeatMsAgo: 30 * 60_000 }), NOW)).toBe(
			false,
		)
	})

	it("ignores a row that is not investigating", () => {
		expect(isInvestigationStale(row({ status: "diagnosed" }), NOW)).toBe(false)
	})

	it("ignores a row that never started", () => {
		expect(isInvestigationStale({ status: "investigating", startedAt: null }, NOW)).toBe(false)
	})
})

/**
 * The sweep's predicate against a real Postgres.
 *
 * The heartbeat clause is a raw `jsonb` fragment, so a typecheck says nothing about it: a wrong
 * operator, a cast that throws on the stored shape, or a NULL comparison quietly excluding every
 * row would all pass `tsc` and fail in prod, on a statement that runs every tick.
 */
describe("sweepAbandonedInvestigations", () => {
	const seed = (id: string, input: { startedMsAgo: number; heartbeatMsAgo?: number; progress?: unknown }) =>
		Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(investigations).values({
					id: asInvestigationId(`00000000-0000-4000-8000-${id.padStart(12, "0")}`),
					orgId: ORG,
					status: "investigating",
					seededBy: "system",
					subjectJson: { type: "question", question: "seed" },
					startedAt: new Date(NOW - input.startedMsAgo),
					createdAt: new Date(NOW - input.startedMsAgo),
					updatedAt: new Date(NOW - input.startedMsAgo),
					...(input.progress !== undefined
						? { progressJson: input.progress as never }
						: input.heartbeatMsAgo === undefined
							? undefined
							: {
									progressJson: {
										stepCount: 3,
										steps: [],
										updatedAt: NOW - input.heartbeatMsAgo,
									},
								}),
				}),
			)
		})

	const statusOf = (id: string) =>
		Effect.gen(function* () {
			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db
					.select({ status: investigations.status })
					.from(investigations)
					.where(
						eq(
							investigations.id,
							asInvestigationId(`00000000-0000-4000-8000-${id.padStart(12, "0")}`),
						),
					),
			)
			return rows[0]?.status
		})

	it.effect("fails the abandoned rows and spares the live one", () =>
		Effect.gen(function* () {
			yield* seed("1", { startedMsAgo: STALE_MS + 60_000 })
			yield* seed("2", { startedMsAgo: 18 * 60_000, heartbeatMsAgo: 8_000 })
			yield* seed("3", {
				startedMsAgo: 30 * 60_000,
				heartbeatMsAgo: PROGRESS_HEARTBEAT_STALE_MS + 60_000,
			})
			yield* seed("4", { startedMsAgo: 60_000 })

			const database = yield* Database
			const moved = yield* database.execute((db) => sweepAbandonedInvestigations(db, NOW))

			assert.strictEqual(moved, 2)
			assert.strictEqual(yield* statusOf("1"), "failed")
			assert.strictEqual(yield* statusOf("2"), "investigating")
			assert.strictEqual(yield* statusOf("3"), "failed")
			assert.strictEqual(yield* statusOf("4"), "investigating")
		}).pipe(Effect.provide(makeLayer())),
	)

	/** `coalesce` to zero: progress without the key must read as no heartbeat, not as NULL. */
	it.effect("sweeps a row whose progress carries no updatedAt", () =>
		Effect.gen(function* () {
			yield* seed("5", {
				startedMsAgo: STALE_MS + 60_000,
				progress: { stepCount: 1, steps: [] },
			})
			const database = yield* Database
			assert.strictEqual(yield* database.execute((db) => sweepAbandonedInvestigations(db, NOW)), 1)
			assert.strictEqual(yield* statusOf("5"), "failed")
		}).pipe(Effect.provide(makeLayer())),
	)
})

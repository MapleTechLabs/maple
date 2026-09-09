import { afterEach, assert, describe, it } from "@effect/vitest"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { durableStep } from "./durable-step"
import { loadOptionalFeatureState, runClickHouseSchemaApply } from "./ClickHouseSchemaApplyWorkflow.run"

/** The step's Effect as `task` hands it over, with the body context already provided. */
const stepEffect = <T>(options: Cloudflare.WorkflowTaskOptions<T, any, any>): Effect.Effect<T> =>
	// SAFETY: alchemy's own step wrapper makes the same narrowing before it runs the Effect.
	options.effect as Effect.Effect<T>

/** Runs each durable step's Effect directly — no retries, no persistence. */
const inlineStep: Cloudflare.WorkflowStep["Service"] = {
	do: (options) => stepEffect(options),
	sleep: () => Effect.void,
	sleepUntil: () => Effect.void,
	waitForEvent: () => Effect.never,
}

class ClickHouseDenied extends Schema.TaggedError<ClickHouseDenied>()("ClickHouseDenied", {
	message: Schema.String,
}) {}

describe("loadOptionalFeatureState", () => {
	const successfulReads = {
		readServerVersion: Effect.succeed("26.2.1"),
		readAppliedFeatureRevisions: Effect.succeed(new Map([["search_text_v1", 1]])),
	}

	it.effect("turns feature bookkeeping creation failure into an unavailable optional state", () =>
		Effect.gen(function* () {
			const state = yield* loadOptionalFeatureState({
				...successfulReads,
				ensureBookkeeping: Effect.fail(new ClickHouseDenied({ message: "CREATE TABLE denied" })),
			})
			assert.deepStrictEqual(state, { available: false, reason: "CREATE TABLE denied" })
		}),
	)

	it.effect(
		"turns a failed durable read (a defect past its retries) into an unavailable optional state",
		() =>
			Effect.gen(function* () {
				const state = yield* loadOptionalFeatureState({
					...successfulReads,
					ensureBookkeeping: Effect.void,
					readAppliedFeatureRevisions: durableStep(
						"read-applied-features",
						Effect.fail(new ClickHouseDenied({ message: "SELECT denied" })),
					),
				}).pipe(Effect.provideService(Cloudflare.WorkflowStep, inlineStep))
				assert.deepStrictEqual(state, { available: false, reason: "SELECT denied" })
			}),
	)

	it.effect("returns the server and applied revisions only after every optional read succeeds", () =>
		Effect.gen(function* () {
			const state = yield* loadOptionalFeatureState({
				...successfulReads,
				ensureBookkeeping: Effect.void,
			})
			assert.isTrue(state.available)
			if (state.available) {
				assert.strictEqual(state.serverVersion, "26.2.1")
				assert.deepStrictEqual([...state.appliedFeatureRevisions], [["search_text_v1", 1]])
			}
		}),
	)
})

describe("runClickHouseSchemaApply failure bookkeeping", () => {
	const trackedDbs: TestDb[] = []
	afterEach(() => cleanupTestDbs(trackedDbs))

	const ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64")

	/** The run as the alchemy class provides it, minus the connection scope and telemetry. */
	const runFor = (testDb: TestDb, env: Record<string, unknown>, orgId: string) =>
		runClickHouseSchemaApply({ orgId }).pipe(
			Effect.provide(
				Layer.mergeAll(
					testDb.layer,
					Layer.succeed(Cloudflare.WorkflowStep, inlineStep),
					Layer.succeed(Cloudflare.WorkerEnvironment, env),
				),
			),
			Effect.scoped,
			Effect.exit,
		)

	const seedQueuedRun = (testDb: TestDb, orgId: string) =>
		Effect.promise(() =>
			executeSql(
				testDb,
				`INSERT INTO org_clickhouse_schema_apply_runs (org_id, status, phase, created_at, updated_at)
				 VALUES ($1, 'queued', 'queued', now(), now())`,
				[orgId],
			),
		)

	const readRun = (testDb: TestDb, orgId: string) =>
		Effect.promise(() =>
			queryFirstRow<{ status: string; error_message: string | null }>(
				testDb,
				"SELECT status, error_message FROM org_clickhouse_schema_apply_runs WHERE org_id = $1",
				[orgId],
			),
		)

	const defectMessage = (exit: Exit.Exit<unknown, never>): string => {
		assert.isTrue(Exit.isFailure(exit))
		if (!Exit.isFailure(exit)) return ""
		assert.isDefined(exit.cause.reasons.find(Cause.isDieReason))
		const error = Cause.squash(exit.cause)
		return error instanceof Error ? error.message : String(error)
	}

	it.effect("marks the run failed when config loading fails, instead of leaving it queued", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			// A queued claim exists, but the org's settings row does not (deleted
			// after queueing) — loadConfig fails before any migration work starts.
			yield* seedQueuedRun(testDb, "org_wf_cfg")

			const exit = yield* runFor(
				testDb,
				{ MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY },
				"org_wf_cfg",
			)
			assert.include(defectMessage(exit), "No ClickHouse settings configured")

			// Without the failed transition, OrgClickHouseSettingsService reads the
			// leftover "queued" as already_running forever.
			const row = yield* readRun(testDb, "org_wf_cfg")
			assert.strictEqual(row?.status, "failed")
			assert.include(row?.error_message ?? "", "No ClickHouse settings configured")
		}),
	)

	it.effect("marks the run failed when the encryption key is missing from the Worker env", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* seedQueuedRun(testDb, "org_wf_nokey")

			const exit = yield* runFor(testDb, {}, "org_wf_nokey")
			assert.include(defectMessage(exit), "MAPLE_INGEST_KEY_ENCRYPTION_KEY")

			const row = yield* readRun(testDb, "org_wf_nokey")
			assert.strictEqual(row?.status, "failed")
			assert.include(row?.error_message ?? "", "MAPLE_INGEST_KEY_ENCRYPTION_KEY")
		}),
	)
})

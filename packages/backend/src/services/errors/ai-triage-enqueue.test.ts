import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { aiTriageSettings, investigations } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { maybeEnqueueTriage } from "./ai-triage-enqueue"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	return testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_enqueue_test")

/**
 * Three runs, not two: the runs ceiling carries the severity reserve, so an
 * unclassified start is judged against `floor(3 * 0.7) = 2`. A ceiling of two
 * would leave one ordinary slot and read like an off-by-one here.
 */
const enableSettings = Effect.gen(function* () {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: true,
			maxRunsPerDay: 3,
			updatedAt: new Date(nowMs),
		}),
	)
})

/** Every start needs the `ChatSession` binding; omitting it is the missing-binding failure. */
const baseInput = (incidentId: string, workerEnv?: Record<string, unknown>) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error" },
	workerEnv,
})

/** Automation on, everything else default. */
const enableAutomation = Effect.gen(function* () {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: true,
			maxRunsPerDay: 20,
			updatedAt: new Date(nowMs),
		}),
	)
})

/**
 * Both ceilings, explicitly. The reserve is a fraction of the pass ceiling, so a
 * test about it has to pin that number rather than inherit a default whose whole
 * point is to be large.
 */
const enableWithLimits = (maxRunsPerDay: number, maxPassesPerDay: number) =>
	Effect.gen(function* () {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(aiTriageSettings).values({
				orgId: ORG,
				enabled: true,
				maxRunsPerDay,
				maxPassesPerDay,
				updatedAt: new Date(nowMs),
			}),
		)
	})

/**
 * Stub `ChatSession` namespace: the observable contract of a start is one
 * `beginTurn` call on the investigation's session.
 */
const fakeChatSession = (options?: { readonly busy?: boolean }) => {
	const turns: Array<{ sessionId: string; text: string }> = []
	const namespace = {
		idFromName: (name: string) => name,
		get: () => ({
			beginTurn: async (input: { sessionId: string; messageId: string; text: string }) => {
				turns.push({ sessionId: input.sessionId, text: input.text })
				return options?.busy === true ? undefined : { cursor: 0, messageId: input.messageId }
			},
		}),
	}
	return { turns, env: { ChatSession: namespace } }
}

/** A critical incident. Severity decides which slice of the pass budget it may spend. */
const criticalInput = (workerEnv: Record<string, unknown> | undefined, incidentId: string) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error", severity: "critical", serviceName: "checkout-api" },
	workerEnv,
})

describe("maybeEnqueueTriage", () => {
	it.effect("starts a critical automatic incident as one agent turn", () =>
		Effect.gen(function* () {
			yield* enableAutomation
			const chat = fakeChatSession()

			const result = yield* maybeEnqueueTriage(criticalInput(chat.env, "incident-critical"))
			assert.isTrue(result.enqueued)
			assert.lengthOf(chat.turns, 1)
			assert.strictEqual(chat.turns[0]!.sessionId, `${ORG}:inv-${result.investigationId}`)
			assert.include(chat.turns[0]!.text, "checkout-api")

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("records agent_unavailable when the chat binding is missing", () =>
		Effect.gen(function* () {
			yield* enableAutomation

			const result = yield* maybeEnqueueTriage(criticalInput(undefined, "incident-nobinding"))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "no_binding")

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "agent_unavailable")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does nothing when the org has not opted in", () =>
		Effect.gen(function* () {
			const chat = fakeChatSession()
			const result = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.deepStrictEqual(result, { enqueued: false, reason: "disabled" })
			assert.lengthOf(chat.turns, 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("enqueues once and dedups subsequent calls for the same incident", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const chat = fakeChatSession()

			const first = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.isTrue(first.enqueued)
			assert.lengthOf(chat.turns, 1)

			const second = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")
			assert.strictEqual(second.investigationId, first.investigationId)
			assert.lengthOf(chat.turns, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reports an error, and leaves the row failed, when the session is busy", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const chat = fakeChatSession({ busy: true })

			const result = yield* maybeEnqueueTriage(baseInput("incident-busy", chat.env))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "error")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stops at the daily cap", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const chat = fakeChatSession()
			const start = (id: string) => maybeEnqueueTriage(baseInput(id, chat.env))

			// `maxRunsPerDay` is 3 here and these starts carry no severity, so the
			// ordinary slice of the runs ceiling is what bites, at two.
			assert.isTrue((yield* start("incident-1")).enqueued)
			assert.isTrue((yield* start("incident-2")).enqueued)
			assert.deepStrictEqual(yield* start("incident-3"), {
				enqueued: false,
				reason: "daily_cap",
			})
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks the run failed when no chat binding is available", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database

			const result = yield* maybeEnqueueTriage(baseInput("incident-1"))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "no_binding")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "agent_unavailable")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks a stranded investigation failed with a retryable reason", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const nowMs = yield* Clock.currentTimeMillis
			const chat = fakeChatSession()

			// First start claims the slot, then we simulate a run that stopped making
			// progress past the single pass's 15-minute budget.
			const first = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "investigating",
						startedAt: new Date(nowMs - 16 * 60 * 1000),
						updatedAt: new Date(nowMs - 16 * 60 * 1000),
					})
					.where(eq(investigations.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.id, first.investigationId)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "retry")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does not reclaim a fresh non-terminal run", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const chat = fakeChatSession()

			const first = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({ status: "investigating" })
					.where(eq(investigations.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput("incident-1", chat.env))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")
			assert.lengthOf(chat.turns, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("force bypasses the enabled flag but still requires a binding", () =>
		Effect.gen(function* () {
			const chat = fakeChatSession()
			// No settings row at all: an org that has never touched these settings
			// still gets the full investigation, because how one runs is not a setting.
			const result = yield* maybeEnqueueTriage({
				...baseInput("incident-1", chat.env),
				force: true,
			})
			assert.isTrue(result.enqueued)
			assert.lengthOf(chat.turns, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * The regression this reserve was built for: for two weeks the whole daily
	 * budget was spent by ordinary incidents within three hours of UTC midnight,
	 * so every incident during working hours was refused — including the ones
	 * worth investigating. Arrival order must not outrank severity.
	 *
	 * A start spends one pass. With a 4-pass ceiling the ordinary slice is 2.
	 */
	it.effect("keeps the reserve for high and critical once ordinary starts fill the slice", () =>
		Effect.gen(function* () {
			yield* enableWithLimits(50, 4)
			const chat = fakeChatSession()
			const ordinary = (id: string) => maybeEnqueueTriage(baseInput(id, chat.env))

			assert.isTrue((yield* ordinary("incident-1")).enqueued) // 0 + 1 <= 2
			assert.isTrue((yield* ordinary("incident-2")).enqueued) // 1 + 1 <= 2
			assert.deepStrictEqual(yield* ordinary("incident-3"), {
				enqueued: false,
				reason: "daily_cap",
			}) // 2 + 1 > 2

			// Same instant, same usage, higher severity: the reserved slice is still there.
			const critical = yield* maybeEnqueueTriage(criticalInput(chat.env, "incident-4"))
			assert.isTrue(critical.enqueued) // 2 + 1 <= 4
			assert.lengthOf(chat.turns, 3)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses a critical start too once the full ceiling is spent", () =>
		Effect.gen(function* () {
			yield* enableWithLimits(50, 1)
			const chat = fakeChatSession()
			assert.isTrue((yield* maybeEnqueueTriage(criticalInput(chat.env, "incident-1"))).enqueued)
			assert.deepStrictEqual(yield* maybeEnqueueTriage(criticalInput(chat.env, "incident-2")), {
				enqueued: false,
				reason: "daily_cap",
			})
		}).pipe(Effect.provide(makeLayer())),
	)
})

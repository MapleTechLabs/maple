import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { errorIssues, issueEscalationPolicies, issueEscalations } from "@maple/db"
import { eq } from "drizzle-orm"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Database } from "@/lib/DatabaseLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "@/lib/test-sqlite"
import { EscalationService } from "./EscalationService"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

const testConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3476",
			MCP_PORT: "3477",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

interface DispatchCall {
	readonly orgId: string
	readonly destinationIds: ReadonlyArray<string>
	readonly request: NotificationRequest
}

const makeHarness = (
	dispatchResult: { delivered: number; failed: number } = { delivered: 1, failed: 0 },
) => {
	const calls: DispatchCall[] = []
	const dispatcherStub = Layer.succeed(NotificationDispatcher, {
		dispatch: (orgId, destinationIds, request) =>
			Effect.sync(() => {
				calls.push({ orgId, destinationIds: [...destinationIds], request })
				return dispatchResult
			}),
	})
	const { url } = makeTempDb("maple-escalation-", createdTempDirs)
	const base = DatabaseLibsqlLive.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig(url)))
	const layer = EscalationService.layer.pipe(Layer.provide(dispatcherStub), Layer.provideMerge(base))
	return { calls, layer }
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_escalation_test")

const seedIssue = (issueId: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = Date.now()
		yield* database.execute((db) =>
			db.insert(errorIssues).values({
				id: issueId as never,
				orgId: ORG,
				fingerprintHash: `fp-${issueId}`,
				serviceName: "checkout-api",
				exceptionType: "TimeoutError",
				exceptionMessage: "upstream timed out",
				topFrame: "",
				severity: "high",
				severitySource: "ai",
				firstSeenAt: now,
				lastSeenAt: now,
				createdAt: now,
				updatedAt: now,
			}),
		)
	})

const seedEscalation = (
	issueId: string,
	overrides: Partial<typeof issueEscalations.$inferInsert> = {},
) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(issueEscalations).values({
				id: randomUUID(),
				orgId: ORG,
				issueId: issueId as never,
				severity: "high",
				source: "ai",
				reason: "severity_set",
				payloadJson: JSON.stringify({ confidence: "medium" }),
				status: "queued",
				attempts: 0,
				dedupeKey: `esc:${ORG}:${issueId}:high`,
				createdAt: Date.now(),
				...overrides,
			}),
		)
	})

const seedPolicy = (rulesJson: string, enabled = 1) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(issueEscalationPolicies).values({
				orgId: ORG,
				enabled,
				rulesJson,
				updatedAt: Date.now(),
				updatedBy: "user_test",
			}),
		)
	})

const loadEscalations = Effect.gen(function* () {
	const database = yield* Database
	return yield* database.execute((db) =>
		db.select().from(issueEscalations).where(eq(issueEscalations.orgId, ORG)),
	)
})

const highRule = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify([{ severity: "high", destinationIds: [randomUUID()], ...overrides }])

describe("EscalationService.runEscalationTick", () => {
	it.effect("dispatches a queued escalation through the policy and marks it sent", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 1, skipped: 0, failed: 0, retried: 0 })
			assert.lengthOf(calls, 1)
			assert.strictEqual(calls[0]?.orgId, ORG)
			const escalation = calls[0]?.request.escalation as Record<string, unknown>
			assert.strictEqual((escalation.issue as Record<string, unknown>).id, issueId)
			assert.strictEqual(escalation.source, "ai")

			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "sent")
			assert.strictEqual(rows[0]?.attempts, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("skips when no policy exists or the policy is disabled", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule(), 0)

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0, retried: 0 })
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "skipped")
			assert.strictEqual(rows[0]?.error, "policy_disabled")
		}).pipe(Effect.provide(layer))
	})

	it.effect("skips when no rule matches the escalation severity", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(JSON.stringify([{ severity: "critical", destinationIds: [randomUUID()] }]))

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.strictEqual(result.skipped, 1)
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.error, "no_destinations_for_severity")
		}).pipe(Effect.provide(layer))
	})

	it.effect("gates AI escalations below the rule's minimum confidence", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId, { payloadJson: JSON.stringify({ confidence: "low" }) })
			yield* seedPolicy(highRule({ minConfidence: "high" }))

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.strictEqual(result.skipped, 1)
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.error, "below_min_confidence")
		}).pipe(Effect.provide(layer))
	})

	it.effect("lets manual escalations through the confidence gate", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId, { source: "manual", payloadJson: "{}" })
			yield* seedPolicy(highRule({ minConfidence: "high" }))

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.strictEqual(result.sent, 1)
			assert.lengthOf(calls, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("retries failed deliveries and fails after the attempt budget", () => {
		const { layer } = makeHarness({ delivered: 0, failed: 1 })
		return Effect.gen(function* () {
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())

			const service = yield* EscalationService

			const first = yield* service.runEscalationTick()
			assert.strictEqual(first.retried, 1)
			let rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "queued")
			assert.strictEqual(rows[0]?.attempts, 1)

			const second = yield* service.runEscalationTick()
			assert.strictEqual(second.retried, 1)

			const third = yield* service.runEscalationTick()
			assert.strictEqual(third.failed, 1)
			rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "failed")
			assert.strictEqual(rows[0]?.attempts, 3)
		}).pipe(Effect.provide(layer))
	})
})

import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { ErrorPersistenceError, OrgId, UserId } from "@maple/domain/http"
import { errorIssues, errorIssueEvents, issueEscalations } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database, DatabaseError } from "../lib/DatabaseLive"
import { DatabaseLibsqlLive } from "../lib/DatabaseLibsqlLive"
import { Env } from "../lib/Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "../lib/test-sqlite"
import type { WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { describeCause, ErrorsService, isBusyDatabaseError, makePersistenceError } from "./ErrorsService"
import { NotificationDispatcher } from "./NotificationDispatcher"

describe("makePersistenceError", () => {
	it("omits the cause key when the source has no cause", () => {
		const err = makePersistenceError(new Error("boom"))
		expect("cause" in err).toBe(false)
		expect(err.message).toBe("boom")
	})

	it("includes cause when the source carries one", () => {
		const inner = new Error("inner")
		const outer = new Error("boom", { cause: inner })
		const err = makePersistenceError(outer)
		expect(typeof err.cause).toBe("string")
		expect(err.cause).toContain("inner")
	})

	it("survives a Schema round-trip when cause is absent", async () => {
		const err = makePersistenceError(new Error("boom"))
		const encoded = Schema.encodeSync(ErrorPersistenceError)(err)
		const decoded = Schema.decodeUnknownSync(ErrorPersistenceError)(encoded)
		expect("cause" in decoded).toBe(false)
		expect(decoded.message).toBe("boom")
	})
})

describe("describeCause", () => {
	it("returns undefined for null/undefined", () => {
		expect(describeCause(null)).toBeUndefined()
		expect(describeCause(undefined)).toBeUndefined()
	})

	it("returns the message/stack for Error instances", () => {
		const e = new Error("x")
		expect(describeCause(e)).toContain("x")
	})

	it("returns the string itself for string causes", () => {
		expect(describeCause("oops")).toBe("oops")
	})
})

describe("isBusyDatabaseError", () => {
	const makeError = (message: string, cause: unknown = null) =>
		new DatabaseError({ message, cause })

	it("matches SQLITE_BUSY in message", () => {
		expect(isBusyDatabaseError(makeError("SQLITE_BUSY: database is locked"))).toBe(true)
	})

	it("matches D1_BUSY in message", () => {
		expect(isBusyDatabaseError(makeError("D1_BUSY: write conflict"))).toBe(true)
	})

	it("matches busy pattern in nested cause", () => {
		const cause = new Error("internal SQLITE_BUSY trying to commit")
		expect(isBusyDatabaseError(makeError("wrapper", cause))).toBe(true)
	})

	it("rejects unrelated database errors", () => {
		expect(isBusyDatabaseError(makeError("UNIQUE constraint failed"))).toBe(false)
		expect(isBusyDatabaseError(makeError("no such table"))).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// setSeverity (libsql-backed integration)
// ---------------------------------------------------------------------------

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

const testConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
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

const warehouseStub: WarehouseQueryServiceShape = {
	query: () => Effect.die(new Error("unexpected warehouse query")) as never,
	sqlQuery: () => Effect.succeed([] as never),
	compiledQuery: () => Effect.succeed([] as never),
	compiledQueryFirst: () => Effect.die(new Error("unexpected warehouse query")) as never,
	ingest: () => Effect.void,
}

const makeErrorsLayer = () => {
	const { url } = makeTempDb("maple-errors-severity-", createdTempDirs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig(url)))
	const databaseLive = DatabaseLibsqlLive.pipe(Layer.provide(envLive))
	const dispatcherStub = Layer.succeed(NotificationDispatcher, {
		dispatch: () => Effect.succeed({ delivered: 0, failed: 0 }),
	})
	return ErrorsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				envLive,
				databaseLive,
				Layer.succeed(WarehouseQueryService, warehouseStub),
				dispatcherStub,
			),
		),
		Layer.provideMerge(databaseLive),
	)
}

const asOrgIdSeverity = Schema.decodeUnknownSync(OrgId)
const asUserIdSeverity = Schema.decodeUnknownSync(UserId)
const SEVERITY_ORG = asOrgIdSeverity("org_severity_service_test")
const SEVERITY_USER = asUserIdSeverity("user_severity_test")

const seedIssue = (issueId: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = Date.now()
		yield* database.execute((db) =>
			db.insert(errorIssues).values({
				id: issueId as never,
				orgId: SEVERITY_ORG,
				fingerprintHash: `fp-${issueId}`,
				serviceName: "checkout-api",
				exceptionType: "TimeoutError",
				exceptionMessage: "upstream timed out",
				topFrame: "",
				firstSeenAt: now,
				lastSeenAt: now,
				createdAt: now,
				updatedAt: now,
			}),
		)
	})

describe("ErrorsService.setSeverity", () => {
	it.effect("sets a manual severity, records the event, and queues an escalation", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(SEVERITY_ORG, SEVERITY_USER)

			const updated = yield* errors.setSeverity(
				SEVERITY_ORG,
				actor.id,
				issueId as never,
				"critical",
				{ note: "paging-worthy" },
			)
			assert.strictEqual(updated.severity, "critical")
			assert.strictEqual(updated.severitySource, "manual")

			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId as never)),
			)
			const severityEvents = events.filter((e) => e.type === "severity_change")
			assert.lengthOf(severityEvents, 1)
			const payload = JSON.parse(severityEvents[0]?.payloadJson ?? "{}")
			assert.strictEqual(payload.to, "critical")
			assert.strictEqual(payload.source, "manual")
			assert.strictEqual(payload.note, "paging-worthy")

			const escalations = yield* database.execute((db) =>
				db.select().from(issueEscalations).where(eq(issueEscalations.issueId, issueId as never)),
			)
			assert.lengthOf(escalations, 1)
			assert.strictEqual(escalations[0]?.source, "manual")
			assert.strictEqual(escalations[0]?.reason, "severity_set")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("an AI write never clobbers a manual severity", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(SEVERITY_ORG, SEVERITY_USER)

			yield* errors.setSeverity(SEVERITY_ORG, actor.id, issueId as never, "low")
			const afterAi = yield* errors.setSeverity(SEVERITY_ORG, actor.id, issueId as never, "critical", {
				source: "ai",
			})
			assert.strictEqual(afterAi.severity, "low")
			assert.strictEqual(afterAi.severitySource, "manual")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("clearing severity nulls both fields and skips escalation", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(SEVERITY_ORG, SEVERITY_USER)

			yield* errors.setSeverity(SEVERITY_ORG, actor.id, issueId as never, "medium")
			const cleared = yield* errors.setSeverity(SEVERITY_ORG, actor.id, issueId as never, null)
			assert.isNull(cleared.severity)
			assert.isNull(cleared.severitySource)

			const escalations = yield* database.execute((db) =>
				db.select().from(issueEscalations).where(eq(issueEscalations.issueId, issueId as never)),
			)
			// Only the initial "medium" set escalates; clearing routes nothing.
			assert.lengthOf(escalations, 1)
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("listIssues filters by severity and kind", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const issueId = randomUUID()
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(SEVERITY_ORG, SEVERITY_USER)
			yield* errors.setSeverity(SEVERITY_ORG, actor.id, issueId as never, "high")

			const alertIssueId = randomUUID()
			const now = Date.now()
			yield* database.execute((db) =>
				db.insert(errorIssues).values({
					id: alertIssueId as never,
					orgId: SEVERITY_ORG,
					kind: "alert" as never,
					fingerprintHash: "alert:rule-1:checkout",
					serviceName: "checkout",
					exceptionType: "High latency",
					exceptionMessage: "p95_latency gte 800",
					topFrame: "",
					firstSeenAt: now,
					lastSeenAt: now,
					createdAt: now,
					updatedAt: now,
				}),
			)

			const high = yield* errors.listIssues(SEVERITY_ORG, { severity: "high" })
			assert.deepStrictEqual(
				high.issues.map((i) => i.id),
				[issueId],
			)

			const unset = yield* errors.listIssues(SEVERITY_ORG, { severity: "unset" })
			assert.deepStrictEqual(
				unset.issues.map((i) => i.id),
				[alertIssueId],
			)

			const alerts = yield* errors.listIssues(SEVERITY_ORG, { kind: "alert" })
			assert.deepStrictEqual(
				alerts.issues.map((i) => i.id),
				[alertIssueId],
			)
			assert.strictEqual(alerts.issues[0]?.kind, "alert")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)
})

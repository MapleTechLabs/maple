import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { alertIncidents, errorIssues, errorIssueEvents } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Database } from "@/lib/DatabaseLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "@/lib/test-sqlite"
import { alertIssueFingerprint, detectorSeverityFor, upsertAlertIssue } from "./issue-hub"

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

const testConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3474",
			MCP_PORT: "3475",
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

const makeLayer = () => {
	const { url } = makeTempDb("maple-issue-hub-", createdTempDirs)
	return DatabaseLibsqlLive.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig(url)))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_issue_hub_test")

const baseInput = (overrides: Partial<Parameters<typeof upsertAlertIssue>[0]> = {}) => ({
	orgId: ORG,
	ruleId: "rule-1",
	ruleName: "High p95 latency",
	groupKey: "checkout",
	signalType: "p95_latency",
	severity: "warning" as const,
	comparator: "gte",
	threshold: 800,
	thresholdUpper: null,
	windowMinutes: 5,
	observedValue: 1240,
	sampleCount: 412,
	incidentId: "incident-1",
	serviceName: "checkout",
	timestamp: 1_750_000_000_000,
	workflowBinding: undefined,
	...overrides,
})

const loadIssue = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db
			.select()
			.from(errorIssues)
			.where(
				and(
					eq(errorIssues.orgId, ORG),
					eq(errorIssues.fingerprintHash, alertIssueFingerprint("rule-1", "checkout")),
				),
			),
	)
	return rows
})

describe("detectorSeverityFor", () => {
	it("maps warning to medium and critical to critical", () => {
		assert.strictEqual(detectorSeverityFor("warning"), "medium")
		assert.strictEqual(detectorSeverityFor("critical"), "critical")
	})
})

describe("upsertAlertIssue", () => {
	it.effect("creates an alert-kind issue with detector severity and links the incident", () =>
		Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(alertIncidents).values({
					id: "incident-1",
					orgId: ORG,
					ruleId: "rule-1",
					incidentKey: "incident-1",
					ruleName: "High p95 latency",
					groupKey: "checkout",
					signalType: "p95_latency",
					severity: "warning",
					status: "open",
					comparator: "gte",
					threshold: 800,
					firstTriggeredAt: 1_750_000_000_000,
					lastTriggeredAt: 1_750_000_000_000,
					dedupeKey: `${ORG}:rule-1:checkout`,
					createdAt: 1_750_000_000_000,
					updatedAt: 1_750_000_000_000,
				}),
			)

			const result = yield* upsertAlertIssue(baseInput())
			assert.strictEqual(result.action, "created")
			assert.isNotNull(result.issueId)

			const issues = yield* loadIssue
			assert.lengthOf(issues, 1)
			const issue = issues[0]!
			assert.strictEqual(issue.kind, "alert")
			assert.strictEqual(issue.workflowState, "triage")
			assert.strictEqual(issue.severity, "medium")
			assert.strictEqual(issue.severitySource, "detector")
			assert.strictEqual(issue.exceptionType, "High p95 latency")
			assert.strictEqual(issue.serviceName, "checkout")
			const sourceRef = JSON.parse(issue.sourceRefJson ?? "{}")
			assert.strictEqual(sourceRef.ruleId, "rule-1")
			assert.strictEqual(sourceRef.latestIncidentId, "incident-1")

			const incidents = yield* database.execute((db) =>
				db.select().from(alertIncidents).where(eq(alertIncidents.id, "incident-1")),
			)
			assert.strictEqual(incidents[0]?.errorIssueId, issue.id)

			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issue.id)),
			)
			assert.lengthOf(events, 1)
			assert.strictEqual(events[0]?.type, "created")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("re-fires refresh the same issue instead of creating a new one", () =>
		Effect.gen(function* () {
			const first = yield* upsertAlertIssue(baseInput())
			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: "incident-2", timestamp: 1_750_000_100_000 }),
			)
			assert.strictEqual(second.action, "refreshed")
			assert.strictEqual(second.issueId, first.issueId)

			const issues = yield* loadIssue
			assert.lengthOf(issues, 1)
			assert.strictEqual(issues[0]?.occurrenceCount, 2)
			const sourceRef = JSON.parse(issues[0]?.sourceRefJson ?? "{}")
			assert.strictEqual(sourceRef.latestIncidentId, "incident-2")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does not clobber an existing severity on re-fire", () =>
		Effect.gen(function* () {
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ severity: "low", severitySource: "manual" })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			yield* upsertAlertIssue(baseInput({ incidentId: "incident-2", severity: "critical" }))

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.severity, "low")
			assert.strictEqual(issues[0]?.severitySource, "manual")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reopens a done issue to triage with regression events", () =>
		Effect.gen(function* () {
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "done", resolvedAt: 1_750_000_050_000 })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: "incident-2", timestamp: 1_750_000_100_000 }),
			)
			assert.strictEqual(second.action, "reopened")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.workflowState, "triage")
			assert.isNull(issues[0]?.resolvedAt)

			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, first.issueId!)),
			)
			const types = events.map((e) => e.type)
			assert.include(types, "state_change")
			assert.include(types, "regression")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("skips a wontfix issue while its snooze is active", () =>
		Effect.gen(function* () {
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "wontfix", snoozeUntil: 1_750_000_999_000 })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: "incident-2", timestamp: 1_750_000_100_000 }),
			)
			assert.strictEqual(second.action, "skipped")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.workflowState, "wontfix")
			assert.strictEqual(issues[0]?.occurrenceCount, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reopens a wontfix issue once its snooze has expired", () =>
		Effect.gen(function* () {
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "wontfix", snoozeUntil: 1_750_000_050_000 })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: "incident-2", timestamp: 1_750_000_100_000 }),
			)
			assert.strictEqual(second.action, "reopened")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.workflowState, "triage")
			assert.isNull(issues[0]?.snoozeUntil)
		}).pipe(Effect.provide(makeLayer())),
	)
})

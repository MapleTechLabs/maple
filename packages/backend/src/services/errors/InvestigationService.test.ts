import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import {
	AiTriageEvidence,
	AiTriageResult,
	InvestigationCreateRequest,
	InvestigationDataCorruptionError,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
	InvestigationId,
	InvestigationNotFoundError,
	InvestigationSubjectSnapshot,
	InvestigationAgentUnavailableError,
	InvestigationStartFailedError,
	OrgId,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import {
	aiTriageSettings,
	errorIssues,
	errorIssueEvents,
	investigationLensRuns,
	investigations,
} from "@maple/db"
import type { MaplePgClient } from "@maple/db/client"
import { createMaplePgliteClient } from "@maple/db/pglite"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { eq } from "drizzle-orm"
import { Env } from "@maple/backend/platform/Env"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { InvestigationService } from "./InvestigationService"

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

const makeHarness = (workerEnvironment?: Record<string, unknown>) => {
	const testDb = createTestDb(createdDbs)
	let layer = InvestigationService.layer.pipe(
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)
	if (workerEnvironment !== undefined) {
		layer = layer.pipe(Layer.provideMerge(Layer.succeed(WorkerEnvironment, workerEnvironment)))
	}
	return { testDb, layer }
}

const makeLayer = () => makeHarness().layer

const ORG = Schema.decodeUnknownSync(OrgId)("org_investigation_test")
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const freeformRequest = (title: string) =>
	new InvestigationCreateRequest({
		subject: new InvestigationFreeformSubject({
			type: "freeform",
			title,
			prompt: `Investigate ${title}`,
			contextRefs: [],
		}),
	})

const incidentRequest = (incidentId: string) =>
	new InvestigationCreateRequest({
		subject: new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: "error",
			incidentId,
		}),
	})

const criticalIncidentRequest = (incidentId: string) =>
	new InvestigationCreateRequest({
		subject: new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: "error",
			incidentId,
		}),
		snapshot: new InvestigationSubjectSnapshot({
			title: "Checkout timeouts",
			scope: "checkout-api",
			status: "open",
			severity: "critical",
			facts: [],
			references: [],
			incidentStartedAt: null,
			incidentEndedAt: null,
		}),
	})

const sampleReport = () =>
	new AiTriageResult({
		summary: "Checkout latency doubled after the 14:00 deploy.",
		suspectedCause: "Regression in the payments client connection pool",
		severityAssessment: "high",
		affectedScope: "checkout-api, p95 across all regions",
		evidence: [
			new AiTriageEvidence({
				traceIds: ["abc123def456"],
				logPatterns: ["pool exhausted"],
				relatedServices: ["payments"],
				note: "Pool saturation in the failing traces",
			}),
		],
		suggestedActions: ["Roll back the 14:00 deploy", "Raise the pool size"],
		confidence: "high",
	})

describe("InvestigationService", () => {
	it.effect("creates a free-form investigation in the investigating state", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const doc = yield* service.createInvestigation(ORG, null, freeformRequest("checkout latency"))
			assert.strictEqual(doc.status, "investigating")
			assert.strictEqual(doc.subject.type, "freeform")
			assert.strictEqual(doc.report, null)
			assert.strictEqual(doc.seededBy, "system")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("dedups incident investigations to one row per incident", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const first = yield* service.createInvestigation(ORG, null, incidentRequest("err_incident_1"))
			const second = yield* service.createInvestigation(ORG, null, incidentRequest("err_incident_1"))
			assert.strictEqual(first.id, second.id)

			const list = yield* service.listInvestigations(ORG, { incidentKind: "error" })
			assert.strictEqual(list.investigations.length, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("submit_diagnosis persists the report and is idempotent", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const created = yield* service.createInvestigation(ORG, null, freeformRequest("error spike"))

			const diagnosed = yield* service.submitDiagnosis(
				ORG,
				created.id,
				new SubmitDiagnosisRequest({ report: sampleReport(), model: "test-model" }),
			)
			assert.strictEqual(diagnosed.status, "diagnosed")
			assert.strictEqual(diagnosed.severity, "high")
			assert.strictEqual(diagnosed.confidence, "high")
			assert.strictEqual(diagnosed.report?.suspectedCause, sampleReport().suspectedCause)
			assert.strictEqual(diagnosed.model, "test-model")

			// Re-diagnosis updates in place without error (idempotent on the id).
			const rediagnosed = yield* service.submitDiagnosis(
				ORG,
				created.id,
				new SubmitDiagnosisRequest({ report: sampleReport() }),
			)
			assert.strictEqual(rediagnosed.id, created.id)
			assert.strictEqual(rediagnosed.status, "diagnosed")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("submit_diagnosis records the turn's tokens on the row without metering them", () => {
		// The chat-session runner meters that turn in full, keyed on the turn. A second
		// meter here billed the same tokens twice; billing here *instead* lost the charge
		// whenever a superseding diagnosis deduplicated against the first one's key.
		const realFetch = globalThis.fetch
		const calls: Array<string> = []
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(String(input instanceof Request ? input.url : input))
			return new Response("{}", { status: 200 })
		}) as typeof fetch
		const harness = makeHarness({
			AUTUMN_SECRET_KEY: "autumn-sk",
			AUTUMN_API_URL: "https://autumn.test",
		})
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const created = yield* service.createInvestigation(ORG, null, freeformRequest("token spike"))

			const diagnosed = yield* service.submitDiagnosis(
				ORG,
				created.id,
				new SubmitDiagnosisRequest({
					report: sampleReport(),
					model: "test-model",
					inputTokens: 4321,
					outputTokens: 210,
				}),
			)

			assert.strictEqual(diagnosed.inputTokens, 4321)
			assert.strictEqual(diagnosed.outputTokens, 210)
			assert.deepStrictEqual(calls, [])
		}).pipe(
			Effect.provide(harness.layer),
			Effect.ensuring(Effect.sync(() => void (globalThis.fetch = realFetch))),
		)
	})

	it.effect("getInvestigation fails with InvestigationNotFoundError for an unknown id", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.getInvestigation(ORG, asInvestigationId("00000000-0000-4000-8000-000000000000")),
			)
			assert.instanceOf(error, InvestigationNotFoundError)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("surfaces malformed stored snapshots and reports instead of erasing them", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const database = yield* Database
			const created = yield* service.createInvestigation(
				ORG,
				null,
				freeformRequest("stored corruption"),
			)

			yield* database.execute((db) =>
				db.update(investigations).set({ snapshotJson: {} }).where(eq(investigations.id, created.id)),
			)
			const snapshotError = yield* Effect.flip(service.getInvestigation(ORG, created.id))
			assert.instanceOf(snapshotError, InvestigationDataCorruptionError)
			assert.strictEqual(snapshotError.field, "snapshot")

			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({ snapshotJson: created.snapshot, reportJson: {} })
					.where(eq(investigations.id, created.id)),
			)
			const reportError = yield* Effect.flip(service.getInvestigation(ORG, created.id))
			assert.instanceOf(reportError, InvestigationDataCorruptionError)
			assert.strictEqual(reportError.field, "report")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("updateStatus transitions an investigation and persists the new status", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const created = yield* service.createInvestigation(ORG, null, freeformRequest("status flow"))
			assert.strictEqual(created.status, "investigating")

			const updated = yield* service.updateStatus(ORG, created.id, "resolved")
			assert.strictEqual(updated.status, "resolved")

			// The change is durable, not just reflected in the return value.
			const fetched = yield* service.getInvestigation(ORG, created.id)
			assert.strictEqual(fetched.status, "resolved")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("updateStatus fails with InvestigationNotFoundError for an unknown id", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.updateStatus(
					ORG,
					asInvestigationId("00000000-0000-4000-8000-000000000001"),
					"resolved",
				),
			)
			assert.instanceOf(error, InvestigationNotFoundError)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * Stub `ChatSession` namespace. The autonomous turn now claims the turn on the ChatSession
	 * Durable Object in process instead of POSTing back to chat-flue over a service binding, so the
	 * observable contract is one `beginTurn` call rather than an HTTP request. The real object
	 * also runs the turn inside itself; nothing here does, which is the point.
	 */
	const chatSessionHarness = (options?: { readonly busy?: boolean }) => {
		const beginTurns: Array<{ messageId: string; text: string }> = []
		const namespace = {
			idFromName: (name: string) => name,
			get: () => ({
				history: async () => [],
				beginTurn: async (input: { messageId: string; text: string }) => {
					beginTurns.push({ messageId: input.messageId, text: input.text })
					return options?.busy === true ? undefined : { cursor: 0, messageId: input.messageId }
				},
				append: async () => 1,
				endTurn: async () => undefined,
			}),
		}
		return { beginTurns, env: { ChatSession: namespace } }
	}

	/**
	 * Every subject — incident, verification, free-form — is one agent turn on the
	 * chat session. There is no second path for an incident to take.
	 */
	it.effect("starts a manual incident as one agent turn with no setup", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const database = yield* Database
			const started = yield* InvestigationService.pipe(
				Effect.flatMap((service) =>
					service.createAndStartInvestigation(ORG, null, criticalIncidentRequest("err_incident")),
				),
			)
			assert.strictEqual(started.status, "investigating")
			assert.lengthOf(chat.beginTurns, 1)
			assert.include(chat.beginTurns[0]!.text, "err_incident")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(rows[0]?.fanoutState, "none")
			assert.strictEqual(rows[0]?.fanoutSize, 1)
			// One agent, one pass against the daily budget.
			assert.strictEqual(rows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("keeps a free-form question on the same single turn", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const started = yield* InvestigationService.pipe(
				Effect.flatMap((service) =>
					service.createAndStartInvestigation(ORG, null, freeformRequest("why is checkout slow")),
				),
			)
			assert.strictEqual(started.status, "investigating")
			assert.lengthOf(chat.beginTurns, 1)

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(rows[0]?.fanoutState, "none")
			assert.strictEqual(rows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("fails retryably when the session already has a turn in flight", () => {
		const chat = chatSessionHarness({ busy: true })
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				InvestigationService.pipe(
					Effect.flatMap((service) =>
						service.createAndStartInvestigation(ORG, null, criticalIncidentRequest("err_busy")),
					),
				),
			)
			assert.isTrue(Exit.isFailure(exit))
			const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
			assert.instanceOf(error, InvestigationStartFailedError)
		}).pipe(Effect.provide(harness.layer))
	})

	/**
	 * The daily budget bounds unattended spend. Gating a person on it made the
	 * Retry button permanently dead once the org was at its ceiling — on a page
	 * whose failure copy tells the reader to press it — and charged a restart as a
	 * fresh run even though the usage query counts rows in today's window and the
	 * row being restarted is already one of them.
	 */
	it.effect("lets a person start and retry after the daily budget is spent", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const database = yield* Database
			const service = yield* InvestigationService
			const now = new Date()

			// Both ceilings set to one, and one investigation already started today —
			// so runs and passes are each exhausted before the calls below.
			yield* database.execute((db) =>
				db.insert(aiTriageSettings).values({
					orgId: ORG,
					enabled: true,
					maxRunsPerDay: 1,
					maxPassesPerDay: 1,
					updatedAt: now,
				}),
			)
			yield* database.execute((db) =>
				db.insert(investigations).values({
					id: asInvestigationId(randomUUID()),
					orgId: ORG,
					subjectJson: freeformRequest("already spent today's budget").subject,
					status: "investigating",
					startedAt: now,
					autonomousTurns: 1,
					createdAt: now,
					updatedAt: now,
				}),
			)

			const started = yield* service.createAndStartInvestigation(
				ORG,
				null,
				criticalIncidentRequest("err_over_budget"),
			)
			assert.strictEqual(started.status, "investigating")

			const restarted = yield* service.restartInvestigation(ORG, started.id)
			assert.strictEqual(restarted.status, "investigating")
			assert.lengthOf(chat.beginTurns, 2)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("hides a previous attempt's legacy lanes on restart", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const database = yield* Database
			const service = yield* InvestigationService
			const started = yield* service.createAndStartInvestigation(
				ORG,
				null,
				criticalIncidentRequest("err_restart"),
			)
			// A lane row from a run before the single-agent rework.
			yield* database.execute((db) =>
				db.insert(investigationLensRuns).values({
					id: "lane-1",
					orgId: ORG,
					investigationId: started.id,
					lensId: "deploy_correlation",
					ordinal: 0,
					status: "reported",
					verdict: "promoted",
					claim: "stale claim from the first attempt",
					createdAt: new Date(),
					updatedAt: new Date(),
				}),
			)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({ fanoutState: "ranked", fanoutSize: 3 })
					.where(eq(investigations.id, started.id)),
			)

			yield* service.restartInvestigation(ORG, started.id)

			// Reads are scoped to the row's current attempt, so the old lane no longer renders.
			const restarted = yield* service.getInvestigation(ORG, started.id)
			assert.lengthOf(restarted.lensRuns, 0)
			assert.strictEqual(restarted.fanout.state, "none")
			assert.lengthOf(chat.beginTurns, 2)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("marks a run failed only while it is still investigating", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const database = yield* Database
			const service = yield* InvestigationService
			const started = yield* service.createAndStartInvestigation(
				ORG,
				null,
				criticalIncidentRequest("err_fail"),
			)
			yield* service.failInvestigation(ORG, started.id, "no_diagnosis: the pass ended in prose")
			const failed = yield* service.getInvestigation(ORG, started.id)
			assert.strictEqual(failed.status, "failed")
			assert.include(failed.error ?? "", "no_diagnosis")

			// A diagnosis that landed meanwhile is never overwritten.
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({ status: "diagnosed", error: null })
					.where(eq(investigations.id, started.id)),
			)
			yield* service.failInvestigation(ORG, started.id, "no_diagnosis: late")
			const diagnosed = yield* service.getInvestigation(ORG, started.id)
			assert.strictEqual(diagnosed.status, "diagnosed")
			assert.isNull(diagnosed.error)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("starts an autonomous turn carrying the preserved context", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			// Free-form, because that is the only route that reaches a chat turn — and
			// this test is about what that turn is handed.
			const service = yield* InvestigationService
			const started = yield* service.createAndStartInvestigation(
				ORG,
				null,
				freeformRequest("err_autonomous_start"),
			)
			assert.strictEqual(started.status, "investigating")
			assert.lengthOf(chat.beginTurns, 1)
			// Labelled sections, not a bare JSON blob. The two facts the prompt opens
			// by demanding — the interval and the identifiers — were being buried in
			// one, and the model routinely skipped both.
			assert.include(chat.beginTurns[0]!.text, "## Interval")
			assert.include(chat.beginTurns[0]!.text, "err_autonomous_start")
			assert.include(chat.beginTurns[0]!.text, '"snapshot"')

			const database = yield* Database
			const databaseRows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(databaseRows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("fails retryably when the chat session binding is missing", () => {
		const harness = makeHarness({})
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.createAndStartInvestigation(ORG, null, incidentRequest("err_no_binding")),
			)
			assert.instanceOf(error, InvestigationAgentUnavailableError)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("fails retryably when a turn is already in flight for the session", () => {
		const chat = chatSessionHarness({ busy: true })
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.createAndStartInvestigation(ORG, null, freeformRequest("err_busy")),
			)
			assert.instanceOf(error, InvestigationStartFailedError)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect(
		"submit_diagnosis writes the issue-linked ai_triage event exactly once across re-diagnosis",
		() => {
			const harness = makeHarness()
			const raw = createMaplePgliteClient(harness.testDb.pglite) as MaplePgClient
			const issueId = asIssueId(randomUUID())
			return Effect.gen(function* () {
				const service = yield* InvestigationService
				// Forcing the service (above) builds the DB layer + runs migrations on the
				// shared PGlite, so the raw client can now seed the linked error issue.
				const now = new Date()
				yield* Effect.promise(() =>
					raw.insert(errorIssues).values({
						id: issueId,
						orgId: ORG,
						fingerprintHash: "98765432109876543210",
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

				const created = yield* service.createInvestigation(
					ORG,
					null,
					new InvestigationCreateRequest({
						subject: new InvestigationIncidentSubject({
							type: "incident",
							incidentKind: "error",
							incidentId: "err_issue_link_1",
							issueId,
						}),
					}),
				)

				// Two diagnosis writes (retry / re-diagnosis): the deterministic event id +
				// onConflictDoNothing must collapse them to a single timeline event.
				yield* service.submitDiagnosis(
					ORG,
					created.id,
					new SubmitDiagnosisRequest({ report: sampleReport() }),
				)
				yield* service.submitDiagnosis(
					ORG,
					created.id,
					new SubmitDiagnosisRequest({ report: sampleReport() }),
				)

				const events = yield* Effect.promise(() =>
					raw.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId)),
				)
				const aiTriageEvents = events.filter((e) => e.type === "ai_triage")
				assert.strictEqual(aiTriageEvents.length, 1)
			}).pipe(Effect.provide(harness.layer))
		},
	)
})

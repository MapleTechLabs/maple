import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import {
	AiTriageEvidence,
	AiTriageResult,
	InvestigationCreateRequest,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
	InvestigationId,
	OrgId,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { Env } from "@/lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
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

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	return InvestigationService.layer.pipe(
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)
}

const ORG = Schema.decodeUnknownSync(OrgId)("org_investigation_test")
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)

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

	it.effect("getInvestigation fails for an unknown id", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const exit = yield* Effect.exit(
				service.getInvestigation(ORG, asInvestigationId("00000000-0000-4000-8000-000000000000")),
			)
			assert.strictEqual(exit._tag, "Failure")
		}).pipe(Effect.provide(makeLayer())),
	)
})

// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { assert, describe, it } from "@effect/vitest"
import { IncidentTriageApiGroup, V1SchemaErrors, V1UnexpectedErrors } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Env } from "@maple/backend/platform/Env"
import { V1ErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { layerDecisionModel, layerLlm } from "../../platform/Llm"
import { HttpTriageLive } from "./triage.http"

const INTERNAL_TOKEN = "test-internal-token"

class TriageOnlyApi extends HttpApi.make("MapleAiApi")
	.add(IncidentTriageApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_APP_BASE_URL: "https://app.example.com",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
	}),
)

const workerEnv = { OPENROUTER_API_KEY: "test-key", MAPLE_DECISION_MODEL: "typesafe/jev-1.13" }

/** What the decisions endpoint answers, so the decode under test is the real one. */
const decisionsAnswer = () =>
	new Response(
		JSON.stringify({
			model: "typesafe/jev-1.13",
			answers: {
				disposition: {
					type: "choice",
					choice: "noise",
					probabilities: { investigate: 0.02, monitor: 0.08, noise: 0.9 },
				},
				severity: {
					type: "score",
					score: 0,
					probabilities: { "0": 0.8, "1": 0.15, "2": 0.04, "3": 0.01 },
				},
				userImpact: { type: "noul", noul: 0.05 },
			},
			usage: { input_tokens: 420, output_tokens: 30 },
		}),
		{ status: 200 },
	)

const makeHarness = () => {
	const decisionCalls: Array<string> = []
	const fetch: typeof globalThis.fetch = async (input, init) => {
		decisionCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
		void init
		return decisionsAnswer()
	}
	const decisions = layerDecisionModel(workerEnv).pipe(
		Layer.provide(layerLlm(workerEnv)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
	)
	const routes = HttpApiBuilder.layer(TriageOnlyApi).pipe(
		Layer.provide(HttpTriageLive.pipe(Layer.provide(decisions))),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(Env.layer.pipe(Layer.provide(config))),
		Layer.provideMerge(Layer.succeed(WorkerEnvironment, workerEnv)),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const classify = async (authorization: string | undefined) => {
		const response = await handler(
			new Request("http://maple-ai.internal/internal/triage/classify", {
				method: "POST",
				headers: {
					...(authorization === undefined ? undefined : { authorization }),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					title: "@maple/cli/ServerError: port 4320 already in use",
					incidentKind: "error",
					reason: "first_seen",
					detectorSeverity: null,
					serviceName: "maple-cli",
					deploymentEnv: null,
					exceptionType: "@maple/cli/ServerError",
					exceptionMessage: "port 4320 already in use",
					topFrame: null,
					occurrenceCount: 353224,
					signalType: null,
					observedValue: null,
					thresholdValue: null,
					priorDiagnoses: [],
				}),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return {
			status: response.status,
			body: text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>),
		}
	}

	return { classify, decisionCalls, dispose }
}

describe("POST /internal/triage/classify", () => {
	it("rejects a caller without the internal service token, before any model call", async () => {
		const harness = makeHarness()
		try {
			assert.strictEqual((await harness.classify(undefined)).status, 400)
			assert.strictEqual((await harness.classify("Bearer maple_svc_wrong")).status, 401)
			assert.strictEqual((await harness.classify("Bearer not-a-service-token")).status, 401)
			assert.lengthOf(harness.decisionCalls, 0)
		} finally {
			await harness.dispose()
		}
	})

	it("answers the classifier's verdict for the internal caller", async () => {
		const harness = makeHarness()
		try {
			const result = await harness.classify(`Bearer maple_svc_${INTERNAL_TOKEN}`)
			assert.strictEqual(result.status, 200)
			assert.deepInclude(result.body, {
				disposition: "noise",
				dispositionConfidence: 0.9,
				severity: "low",
				model: "typesafe/jev-1.13",
			})
			assert.lengthOf(harness.decisionCalls, 1)
			assert.match(harness.decisionCalls[0] ?? "", /\/alpha\/decisions$/)
		} finally {
			await harness.dispose()
		}
	})
})

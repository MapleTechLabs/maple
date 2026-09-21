import { assert, describe, it } from "@effect/vitest"
import { IncidentTriageRequest, IncidentTriageVerdict } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { ConfigProvider, Effect, Layer } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { IncidentClassifier } from "./IncidentClassifier"

const INTERNAL_TOKEN = "test-internal-token"

const config = (withToken: boolean) =>
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
			...(withToken ? { INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN } : undefined),
		}),
	)

const request = new IncidentTriageRequest({
	title: "@maple/cli/ServerError: maple is already running (PID 1)",
	incidentKind: "error",
	reason: "first_seen",
	detectorSeverity: null,
	serviceName: "maple-cli",
	deploymentEnv: null,
	exceptionType: "@maple/cli/ServerError",
	exceptionMessage: "maple is already running (PID 1)",
	topFrame: null,
	occurrenceCount: 1_661_421,
	signalType: null,
	observedValue: null,
	thresholdValue: null,
	priorDiagnoses: [],
})

const verdict = {
	disposition: "noise",
	dispositionConfidence: 0.88,
	severity: "low",
	severityConfidence: 0.7,
	userImpact: 0.1,
	matchedPrior: null,
	model: "~typesafe/jev-latest",
}

/** A service binding: the calls it saw, and what it answers. */
const fakeAiWorker = (answer: () => Response) => {
	const calls: Array<{ url: string; authorization: string | null; body: unknown }> = []
	const binding = {
		fetch: async (req: Request) => {
			calls.push({
				url: req.url,
				authorization: req.headers.get("authorization"),
				body: await req.json(),
			})
			return answer()
		},
	}
	return { calls, env: { AI_WORKER: binding } }
}

const layerFor = (env: Record<string, unknown>, withToken = true) =>
	IncidentClassifier.layer.pipe(
		Layer.provide(Layer.succeed(WorkerEnvironment, env)),
		Layer.provide(Env.layer.pipe(Layer.provide(config(withToken)))),
	)

describe("IncidentClassifier", () => {
	it.effect("posts the request to maple-ai with the internal bearer and decodes the verdict", () => {
		const worker = fakeAiWorker(
			() =>
				new Response(JSON.stringify(verdict), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		)
		return Effect.gen(function* () {
			const classifier = yield* IncidentClassifier
			const result = yield* classifier.classify(request)

			assert.instanceOf(result, IncidentTriageVerdict)
			assert.strictEqual(result?.disposition, "noise")
			assert.lengthOf(worker.calls, 1)
			const call = worker.calls[0]
			assert.match(call?.url ?? "", /\/internal\/triage\/classify$/)
			assert.strictEqual(call?.authorization, `Bearer maple_svc_${INTERNAL_TOKEN}`)
			assert.deepInclude(call?.body as Record<string, unknown>, {
				serviceName: "maple-cli",
				occurrenceCount: 1_661_421,
			})
		}).pipe(Effect.provide(layerFor(worker.env)))
	})

	it.effect("answers nothing when the binding is missing", () =>
		Effect.gen(function* () {
			const classifier = yield* IncidentClassifier
			assert.isNull(yield* classifier.classify(request))
		}).pipe(Effect.provide(layerFor({}))),
	)

	it.effect("answers nothing when the token is missing, without calling out", () => {
		const worker = fakeAiWorker(() => new Response("{}", { status: 200 }))
		return Effect.gen(function* () {
			const classifier = yield* IncidentClassifier
			assert.isNull(yield* classifier.classify(request))
			assert.lengthOf(worker.calls, 0)
		}).pipe(Effect.provide(layerFor(worker.env, false)))
	})

	it.effect("answers nothing on a failed call, never a skip", () => {
		const worker = fakeAiWorker(() => new Response("upstream down", { status: 502 }))
		return Effect.gen(function* () {
			const classifier = yield* IncidentClassifier
			assert.isNull(yield* classifier.classify(request))
			assert.lengthOf(worker.calls, 1)
		}).pipe(Effect.provide(layerFor(worker.env)))
	})
})

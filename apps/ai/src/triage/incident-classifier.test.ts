import { assert, describe, it } from "@effect/vitest"
import { IncidentTriageRequest } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layerDecisionModel, layerLlm } from "../platform/Llm"
import { classifyIncident } from "./incident-classifier"

const env = { OPENROUTER_API_KEY: "test-key" }

const request = new IncidentTriageRequest({
	title: "404 Not Found /wp-admin/setup-config.php",
	incidentKind: "error",
	detectorSeverity: null,
	serviceName: "maple-api",
	deploymentEnv: "production",
	exceptionType: "NotFoundError",
	exceptionMessage: "No route for GET /wp-admin/setup-config.php",
	topFrame: null,
	occurrenceCount: 4120,
	signalType: null,
	observedValue: null,
	thresholdValue: null,
})

/** Answers shaped like the decisions endpoint's, so the decode is the real one. */
const answering = (body: unknown): typeof globalThis.fetch =>
	(async () => new Response(JSON.stringify(body), { status: 200 })) as typeof globalThis.fetch

const run = (fetch: typeof globalThis.fetch) =>
	classifyIncident({ request, model: "~typesafe/jev-latest" }).pipe(
		Effect.provide(Layer.provide(layerDecisionModel(env), layerLlm(env))),
		Effect.provideService(FetchHttpClient.Fetch, fetch),
	)

describe("classifyIncident", () => {
	it.effect("reads the chosen label's own probability mass as the confidence", () =>
		Effect.gen(function* () {
			const verdict = yield* run(
				answering({
					model: "~typesafe/jev-latest",
					answers: {
						disposition: {
							type: "choice",
							choice: "noise",
							probabilities: { investigate: 0.01, monitor: 0.03, noise: 0.96 },
						},
						severity: {
							type: "score",
							score: 0,
							probabilities: { "0": 0.9, "1": 0.06, "2": 0.03, "3": 0.01 },
						},
						userImpact: { type: "noul", noul: 0.12 },
					},
					usage: { input_tokens: 400, output_tokens: 60 },
				}),
			)

			assert.strictEqual(verdict.disposition, "noise")
			// 0.96, not the absent provider `confidence` and not a default.
			assert.strictEqual(verdict.dispositionConfidence, 0.96)
			assert.strictEqual(verdict.severity, "low")
			assert.strictEqual(verdict.userImpact, 0.12)
			assert.strictEqual(verdict.model, "~typesafe/jev-latest")
		}),
	)

	it.effect("maps the top of the scale to critical", () =>
		Effect.gen(function* () {
			const verdict = yield* run(
				answering({
					model: "~typesafe/jev-latest",
					answers: {
						disposition: {
							type: "choice",
							choice: "investigate",
							probabilities: { investigate: 1, monitor: 0, noise: 0 },
						},
						severity: {
							type: "score",
							score: 3,
							probabilities: { "0": 0, "1": 0.02, "2": 0.18, "3": 0.8 },
						},
						userImpact: { type: "noul", noul: 0.75 },
					},
					usage: { input_tokens: 400, output_tokens: 60 },
				}),
			)

			assert.strictEqual(verdict.disposition, "investigate")
			assert.strictEqual(verdict.severity, "critical")
		}),
	)
})

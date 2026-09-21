import { assert, describe, it } from "@effect/vitest"
import { IncidentTriagePriorDiagnosis, IncidentTriageRequest } from "@maple/domain/http"
import { InvestigationId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
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

const run = (fetch: typeof globalThis.fetch, input: IncidentTriageRequest = request) =>
	classifyIncident({ request: input, model: "~typesafe/jev-latest" }).pipe(
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

	it.effect("asks about the prior diagnoses in a second call and maps the label back to the run", () =>
		Effect.gen(function* () {
			const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
			const first = asInvestigationId("11111111-1111-4111-8111-111111111111")
			const second = asInvestigationId("22222222-2222-4222-8222-222222222222")
			const withPriors = new IncidentTriageRequest({
				...request,
				priorDiagnoses: [
					new IncidentTriagePriorDiagnosis({
						investigationId: first,
						headline: "Scanner probing WordPress paths",
						exceptionType: "NotFoundError",
					}),
					new IncidentTriagePriorDiagnosis({
						investigationId: second,
						headline: "Checkout retries exhausted",
						exceptionType: "TimeoutError",
					}),
				],
			})

			// Two questions go out; the body says which one each is.
			const bodies: Array<string> = []
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const body = String(init?.body ?? (input instanceof Request ? await input.text() : ""))
				bodies.push(body)
				const isPriorQuestion = body.includes("prior_2")
				return new Response(
					JSON.stringify(
						isPriorQuestion
							? {
									model: "~typesafe/jev-latest",
									answers: {
										prior: {
											type: "choice",
											choice: "prior_2",
											probabilities: { none: 0.05, prior_1: 0.05, prior_2: 0.9 },
										},
									},
									usage: { input_tokens: 500, output_tokens: 40 },
								}
							: {
									model: "~typesafe/jev-latest",
									answers: {
										disposition: {
											type: "choice",
											choice: "investigate",
											probabilities: { investigate: 0.7, monitor: 0.2, noise: 0.1 },
										},
										severity: {
											type: "score",
											score: 1,
											probabilities: { "0": 0.1, "1": 0.6, "2": 0.2, "3": 0.1 },
										},
										userImpact: { type: "noul", noul: 0.4 },
									},
									usage: { input_tokens: 400, output_tokens: 60 },
								},
					),
					{ status: 200 },
				)
			}

			const verdict = yield* run(fetch, withPriors)
			assert.lengthOf(bodies, 2)
			assert.strictEqual(verdict.matchedPrior?.investigationId, second)
			assert.strictEqual(verdict.matchedPrior?.probability, 0.9)
			assert.strictEqual(verdict.disposition, "investigate")
		}),
	)

	it.effect("reports no match as null, and no priors as absent", () =>
		Effect.gen(function* () {
			const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
			const withPriors = new IncidentTriageRequest({
				...request,
				priorDiagnoses: [
					new IncidentTriagePriorDiagnosis({
						investigationId: asInvestigationId("11111111-1111-4111-8111-111111111111"),
						headline: "Checkout retries exhausted",
						exceptionType: "TimeoutError",
					}),
				],
			})
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const body = String(init?.body ?? (input instanceof Request ? await input.text() : ""))
				return new Response(
					JSON.stringify(
						body.includes("prior_1")
							? {
									model: "~typesafe/jev-latest",
									answers: {
										prior: {
											type: "choice",
											choice: "none",
											probabilities: { none: 0.97, prior_1: 0.03 },
										},
									},
									usage: { input_tokens: 500, output_tokens: 40 },
								}
							: {
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
								},
					),
					{ status: 200 },
				)
			}

			const matched = yield* run(fetch, withPriors)
			assert.isNull(matched.matchedPrior)

			const alone = yield* run(fetch)
			assert.isUndefined(alone.matchedPrior)
		}),
	)
})

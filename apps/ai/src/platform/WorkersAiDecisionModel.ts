/**
 * A `DecisionModel` backed by Cloudflare's Clef on Workers AI (`@cf/cloudflare/clef`).
 *
 * Clef speaks the same typed-question shape as OpenRouter's decisions API (`noul` / `choice` /
 * `score` in, a distribution per question out), so the mapping mirrors `OpenRouterDecisionModel`.
 * The request is a native `.../ai/run/{model}` POST: the Workers AI shim answers it from the `AI`
 * binding when there is one, and otherwise it goes out to the REST endpoint with the API token.
 */
import { Effect, Layer, Schema } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

const MODULE = "WorkersAiDecisionModel"

const Probabilities = Schema.Record(Schema.String, Schema.Number)

const ClefAnswer = Schema.Union([
	Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
	Schema.Struct({
		type: Schema.Literal("choice"),
		choice: Schema.String,
		probabilities: Probabilities,
		confidence: Schema.optional(Schema.Number),
	}),
	Schema.Struct({
		type: Schema.Literal("score"),
		score: Schema.Number,
		probabilities: Probabilities,
		confidence: Schema.optional(Schema.Number),
	}),
])

const ClefOutput = Schema.Struct({
	answers: Schema.Record(Schema.String, ClefAnswer),
	usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
})

/** The REST endpoint wraps the output in `{ result }`; the binding's raw response does not. */
const ClefResponse = Schema.Union([Schema.Struct({ result: ClefOutput }), ClefOutput])

type ClefQuestion =
	| { readonly type: "noul"; readonly instructions: string; readonly criteria: unknown }
	| { readonly type: "choice"; readonly instructions: string; readonly criteria: unknown }
	| { readonly type: "score"; readonly instructions: string; readonly criteria: ReadonlyArray<string> }

/** `@cf/cloudflare/clef-flash` → `clef-flash`: the body names the variant, the URL the model. */
const variantOf = (model: string): string => model.slice(model.lastIndexOf("/") + 1)

const fail = (reason: AiError.AiErrorReason) => AiError.make({ module: MODULE, method: "decide", reason })

const isRequestError = (
	reason: HttpClientError.HttpClientError["reason"],
): reason is HttpClientError.RequestError =>
	reason._tag === "TransportError" || reason._tag === "EncodeError" || reason._tag === "InvalidUrlError"

/** A request that never got an answer is a network error; anything else is the provider's. */
const fromClientError = (error: HttpClientError.HttpClientError) =>
	fail(
		isRequestError(error.reason)
			? AiError.NetworkError.fromRequestError(error.reason)
			: new AiError.InvalidOutputError({ description: error.message }),
	)

export const make = Effect.fnUntraced(function* (options: {
	/** The Workers AI model id, e.g. `@cf/cloudflare/clef`. */
	readonly model: string
	readonly accountId: string
	readonly apiKey: string
}) {
	const client = yield* HttpClient.HttpClient
	const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${options.model}`

	return yield* DecisionModel.make({
		// Tolerate two-decimal rounding drift in a distribution's sum and rescale it, as the
		// OpenRouter decision model does; anything further off is still an invalid output.
		probabilityPrecision: 2,
		decide: Effect.fnUntraced(function* ({ state, decisions }) {
			const questions: Record<string, ClefQuestion> = {}
			for (const [key, decision] of Object.entries(decisions)) {
				switch (decision._tag) {
					case "Classify":
						questions[key] = {
							type: "choice",
							instructions: decision.instructions,
							criteria: decision.criteria,
						}
						break
					case "Rate":
						questions[key] = {
							type: "score",
							instructions: decision.instructions,
							criteria: decision.criteria,
						}
						break
					case "Probability":
						questions[key] = {
							type: "noul",
							instructions: decision.instructions,
							criteria: decision.criteria,
						}
						break
				}
			}

			const request = HttpClientRequest.post(url).pipe(
				HttpClientRequest.bearerToken(options.apiKey),
				HttpClientRequest.bodyJsonUnsafe({ model: variantOf(options.model), state, questions }),
			)
			const response = yield* client.execute(request).pipe(Effect.mapError(fromClientError))
			if (response.status < 200 || response.status >= 300) {
				const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
				return yield* fail(
					AiError.reasonFromHttpStatus({
						status: response.status,
						description: body.slice(0, 500),
					}),
				)
			}
			const decoded = yield* HttpClientResponse.schemaBodyJson(ClefResponse)(response).pipe(
				Effect.mapError((error) =>
					fail(new AiError.InvalidOutputError({ description: error.message })),
				),
			)
			const output = "result" in decoded ? decoded.result : decoded

			const answers: Record<string, DecisionModel.ProviderAnswer> = {}
			for (const [key, answer] of Object.entries(output.answers)) {
				switch (answer.type) {
					case "noul":
						answers[key] = { _tag: "Probability", probability: answer.noul }
						break
					case "choice":
						answers[key] = {
							_tag: "Classify",
							label: answer.choice,
							probabilities: answer.probabilities,
							confidence: answer.confidence,
						}
						break
					case "score": {
						// Score probabilities are keyed by level index; the decision speaks in labels.
						const decision = decisions[key]
						const probabilities: Record<string, number> = {}
						if (decision?._tag === "Rate") {
							for (const [index, label] of decision.criteria.entries()) {
								const probability = answer.probabilities[String(index)]
								if (probability !== undefined) probabilities[label] = probability
							}
						}
						answers[key] = {
							_tag: "Rate",
							rating: answer.score,
							probabilities,
							confidence: answer.confidence,
						}
						break
					}
				}
			}
			return {
				answers,
				usage: { inputTokens: output.usage.input_tokens, outputTokens: output.usage.output_tokens },
			}
		}),
	})
})

export const layer = (options: Parameters<typeof make>[0]) =>
	Layer.effect(DecisionModel.DecisionModel, make(options))

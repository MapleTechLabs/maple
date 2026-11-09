import { OpenAiClient } from "@effect/ai-openai-compat"
import { OpenRouterClient } from "@effect/ai-openrouter"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { openRouterApiUrl, resolveTriageModel, type LlmSettings } from "../platform/Llm"

const EvalEnv = Config.all({
	apiKey: Config.option(Config.NonEmptyString("OPENROUTER_API_KEY")),
	model: Config.option(Config.String("EVAL_MODEL")),
})

/** The environment an eval reads; a malformed value reads as unset, like a missing one. */
const readEvalEnv = () =>
	Effect.runSync(
		EvalEnv.pipe(
			Effect.orElseSucceed(() => ({ apiKey: Option.none<string>(), model: Option.none<string>() })),
		),
	)

/** Evals need an OpenRouter key; without one a suite skips rather than fails. */
export const hasEvalCredentials = (): boolean => Option.isSome(readEvalEnv().apiKey)

/**
 * The model a run evaluates: `EVAL_MODEL`, or the production triage model when unset. Resolved by
 * the same function production uses, so limits and per-model settings match.
 *
 * The clients are built here rather than with `layerLlm` on purpose: that adds Maple's OpenRouter
 * app attribution, and eval spend stays off the product's app page. See `docs/openrouter-tracing.md`.
 */
export const evalModel = () => {
	const env = readEvalEnv()
	const apiKey = Redacted.make(Option.getOrElse(env.apiKey, () => ""))
	const settings: LlmSettings = {
		OPENROUTER_API_KEY: apiKey,
		MAPLE_TRIAGE_MODEL_OPENROUTER: Option.getOrUndefined(env.model),
	}
	const apiUrl = openRouterApiUrl(settings)
	// A resolved model asks for both provider clients; only the OpenRouter one is called.
	const clients = Layer.mergeAll(
		OpenRouterClient.layer({ apiKey, apiUrl }),
		OpenAiClient.layer({ apiKey, apiUrl }),
	).pipe(Layer.provide(FetchHttpClient.layer))
	return { model: resolveTriageModel(settings), clients }
}

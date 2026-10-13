import { OpenAiClient } from "@effect/ai-openai-compat"
import { OpenRouterClient } from "@effect/ai-openrouter"
import { Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { openRouterApiUrl, resolveTriageModel, type LlmSettings } from "../platform/Llm"

/** Evals need an OpenRouter key; without one a suite skips rather than fails. */
export const hasEvalCredentials = (): boolean => Boolean(process.env.OPENROUTER_API_KEY)

/**
 * The model a run evaluates: `EVAL_MODEL`, or the production triage model when unset. Resolved by
 * the same function production uses, so limits and per-model settings match.
 *
 * The clients are built here rather than with `layerLlm` on purpose: that adds Maple's OpenRouter
 * app attribution, and eval spend stays off the product's app page. See `docs/openrouter-tracing.md`.
 */
export const evalModel = () => {
	const apiKey = Redacted.make(process.env.OPENROUTER_API_KEY ?? "")
	const settings: LlmSettings = {
		OPENROUTER_API_KEY: apiKey,
		MAPLE_TRIAGE_MODEL_OPENROUTER: process.env.EVAL_MODEL,
	}
	const apiUrl = openRouterApiUrl(settings)
	// A resolved model asks for both provider clients; only the OpenRouter one is called.
	const clients = Layer.mergeAll(
		OpenRouterClient.layer({ apiKey, apiUrl }),
		OpenAiClient.layer({ apiKey, apiUrl }),
	).pipe(Layer.provide(FetchHttpClient.layer))
	return { model: resolveTriageModel(settings), clients }
}

import { OpenAiClient } from "@effect/ai-openai-compat"
import { OpenRouterClient } from "@effect/ai-openrouter"
import { Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { openRouterApiUrl, resolveTriageModel, type LlmSettings } from "../../platform/Llm"

/** Evals require an OpenRouter key; without one the suites skip rather than fail. */
export const hasEvalCredentials = (): boolean => Boolean(process.env.OPENROUTER_API_KEY)

/**
 * The model evals run on: the triage model the agents use, built by the same resolver.
 * `MCP_EVAL_MODEL` overrides the id; unset, it tracks production.
 *
 * The clients are built here rather than with `layerLlm` on purpose: that adds Maple's OpenRouter
 * app attribution, and eval spend stays off the product's app page. See `docs/openrouter-tracing.md`.
 */
export const evalModelLayer = () => {
	const apiKey = Redacted.make(process.env.OPENROUTER_API_KEY ?? "")
	const settings: LlmSettings = {
		OPENROUTER_API_KEY: apiKey,
		MAPLE_TRIAGE_MODEL_OPENROUTER: process.env.MCP_EVAL_MODEL,
	}
	const apiUrl = openRouterApiUrl(settings)
	// The resolved model's layer asks for both provider clients; only the OpenRouter one is called.
	const clients = Layer.mergeAll(
		OpenRouterClient.layer({ apiKey, apiUrl }),
		OpenAiClient.layer({ apiKey, apiUrl }),
	).pipe(Layer.provide(FetchHttpClient.layer))
	return resolveTriageModel(settings).layer.pipe(Layer.provide(clients))
}

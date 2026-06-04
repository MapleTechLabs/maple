import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"

/**
 * Default eval model — matches apps/chat-agent's prod default
 * (`DEFAULT_MODEL_ID` in apps/chat-agent/src/lib/openrouter.ts), so evals
 * reflect what real users run. Override with `MCP_EVAL_MODEL`.
 */
export const DEFAULT_EVAL_MODEL = "moonshotai/kimi-k2.5"

export const evalModelId = (): string => process.env.MCP_EVAL_MODEL ?? DEFAULT_EVAL_MODEL

/** Evals require an OpenRouter key; without one the suites skip rather than fail. */
export const hasEvalCredentials = (): boolean => Boolean(process.env.OPENROUTER_API_KEY)

/**
 * Build the eval model via OpenRouter — same wiring as
 * apps/chat-agent/src/lib/openrouter.ts `createChatModel`.
 */
export const createEvalModel = (): LanguageModel => {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY is required to run MCP evals")
	}
	const openrouter = createOpenAICompatible({
		name: "openrouter",
		baseURL: "https://openrouter.ai/api/v1",
		apiKey,
	})
	return openrouter.chatModel(evalModelId())
}

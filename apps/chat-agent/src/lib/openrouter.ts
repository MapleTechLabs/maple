import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"

export const OPENROUTER_PROVIDER_NAME = "openrouter"
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const DEFAULT_MODEL_ID = "moonshotai/kimi-k2.5:nitro"

export interface OpenRouterAppOptions {
	readonly appBaseUrl?: string
	readonly appTitle?: string
}

type JsonPrimitive = string | number | boolean | null
type JsonObject = { [key: string]: JsonValue }
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface OpenRouterTraceOptions {
	readonly traceId: string
	readonly traceName?: string
	readonly spanName?: string
	readonly generationName?: string
	readonly parentSpanId?: string
	readonly sessionId?: string
	readonly userId?: string
	readonly orgId?: string
	readonly operation?: string
	readonly mode?: string
	readonly environment?: string
	readonly isByok?: boolean
}

export interface OpenRouterRequestOptions {
	readonly providerOptions: {
		readonly openrouter: JsonObject
	}
}

const nonEmpty = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

const setString = (target: JsonObject, key: string, value: string | undefined) => {
	const trimmed = nonEmpty(value)
	if (trimmed) target[key] = trimmed
}

const setBoolean = (target: JsonObject, key: string, value: boolean | undefined) => {
	if (value !== undefined) target[key] = value
}

export const createOpenRouterHeaders = ({
	appBaseUrl,
	appTitle,
}: OpenRouterAppOptions = {}): Record<string, string> => {
	const headers: Record<string, string> = {
		"X-OpenRouter-Title": nonEmpty(appTitle) ?? "Maple",
	}
	const referer = nonEmpty(appBaseUrl)
	if (referer) headers["HTTP-Referer"] = referer
	return headers
}

export const createChatModel = (
	apiKey: string,
	options: OpenRouterAppOptions = {},
): LanguageModel => {
	const openrouter = createOpenAICompatible({
		name: OPENROUTER_PROVIDER_NAME,
		baseURL: OPENROUTER_BASE_URL,
		apiKey,
		headers: createOpenRouterHeaders(options),
	})
	return openrouter.chatModel(DEFAULT_MODEL_ID)
}

export const createOpenRouterRequestOptions = ({
	traceId,
	traceName,
	spanName,
	generationName,
	parentSpanId,
	sessionId,
	userId,
	orgId,
	operation,
	mode,
	environment,
	isByok,
}: OpenRouterTraceOptions): OpenRouterRequestOptions => {
	const normalizedTraceId = nonEmpty(traceId)
	if (!normalizedTraceId) {
		throw new Error("OpenRouter traceId is required")
	}

	const trace: JsonObject = {
		trace_id: normalizedTraceId,
		trace_name: nonEmpty(traceName) ?? "Maple AI Chat",
		generation_name: nonEmpty(generationName) ?? "OpenRouter Generation",
	}
	setString(trace, "span_name", spanName)
	setString(trace, "parent_span_id", parentSpanId)
	setString(trace, "orgId", orgId)
	setString(trace, "operation", operation)
	setString(trace, "mode", mode)
	setString(trace, "environment", environment)
	setBoolean(trace, "isByok", isByok)

	const openrouter: JsonObject = { trace }
	setString(openrouter, "session_id", sessionId)
	setString(openrouter, "user", userId)

	return {
		providerOptions: {
			openrouter,
		},
	}
}

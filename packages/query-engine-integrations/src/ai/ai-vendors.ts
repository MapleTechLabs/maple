// Per-vendor overrides, keyed by the `maple_ai.vendor.id` the ingest gateway
// stamped on the span.
//
// The default GenAI integration already reads canonical `gen_ai.*`, which is
// what most detected vendors emit, so an override is only worth writing for a
// framework with a different dialect, or a key whose unit differs. Each
// list holds that dialect's keys alone — the default's canonical and legacy
// keys are appended by the merge in `ai-integrations.ts` and keep priority.
// Keys that could not be verified against the emitting source were dropped
// rather than guessed: a wrong key never matches, so it is invisible.

import type { AiIntegration, AiRefineContext } from "./ai-integrations"
import { MAPLE_NATIVE_TURN_ID_ATTR, type MutableAiGenAiValues } from "@maple/domain/gen-ai"
import { CREWAI_AGENT_NAME_KEY } from "@maple/domain/tinybird/gen-ai-columns"

/**
 * Vercel AI SDK — the `ai.*` dialect.
 *
 * Current AI SDK versions emit canonical `gen_ai.*` attributes
 * (`gen_ai.operation.name`, `gen_ai.usage.*` and friends), so these keys serve
 * older versions. All of them appear verbatim in the installed `ai` package's
 * telemetry code.
 *
 * Not mapped: `ai.response.text` (plain text, not the JSON message array
 * `outputMessages` holds), `ai.operationId` (an SDK function id such as
 * `ai.generateText.doGenerate`, not a `gen_ai.operation.name` value), and
 * `ai.response.msToFirstChunk` (milliseconds, where
 * `gen_ai.response.time_to_first_chunk` is seconds — silently mixing units is
 * worse than not having the field). The v7 SDK's
 * `gen_ai.client.operation.time_to_first_chunk` is in seconds and read by the
 * default integration.
 */
const vercelAiSdkIntegration: AiIntegration = {
	id: "vercel_ai_sdk",
	sources: {
		requestModel: ["ai.model.id"],
		providerName: ["ai.model.provider"],
		responseId: ["ai.response.id"],
		responseModel: ["ai.response.model"],
		responseFinishReasons: ["ai.response.finishReason"],
		usageInputTokens: ["ai.usage.inputTokens", "ai.usage.promptTokens"],
		usageOutputTokens: ["ai.usage.outputTokens", "ai.usage.completionTokens"],
		usageCacheReadInputTokens: [
			"ai.usage.cachedInputTokens",
			"ai.usage.inputTokenDetails.cacheReadTokens",
		],
		usageCacheCreationInputTokens: ["ai.usage.inputTokenDetails.cacheWriteTokens"],
		usageReasoningOutputTokens: [
			"ai.usage.reasoningTokens",
			"ai.usage.outputTokenDetails.reasoningTokens",
		],
		inputMessages: ["ai.prompt.messages", "ai.prompt"],
		toolName: ["ai.toolCall.name"],
		toolCallId: ["ai.toolCall.id"],
		toolCallArguments: ["ai.toolCall.args"],
		toolCallResult: ["ai.toolCall.result"],
		toolDefinitions: ["ai.prompt.tools"],
		// `ai.telemetry.functionId` is the name the app gave the traced call —
		// typically the same value a sibling `invoke_agent` span puts in
		// `gen_ai.agent.name`, and the only agent identity an older-SDK span has.
		agentName: ["ai.telemetry.functionId"],
	},
}

/**
 * OpenInference span kinds that have a `gen_ai.operation.name` equivalent. The
 * kinds left out (`CHAIN`, `RERANKER`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`,
 * `UNKNOWN`) have no counterpart in the convention, and inventing one would put
 * a value in `operationName` that no GenAI dashboard filter can match.
 */
const OPENINFERENCE_SPAN_KIND_OPERATIONS = new Map([
	["LLM", "chat"],
	["TOOL", "execute_tool"],
	["AGENT", "invoke_agent"],
	["EMBEDDING", "embeddings"],
	["RETRIEVER", "retrieval"],
])

/**
 * OpenInference — the dialect Arize's instrumentors emit. Registered under both
 * `openinference-openai` (the gateway's id for the OpenAI instrumentor) and
 * `unknown:openinference` (its generic bucket for any other OpenInference
 * scope), because the dialect is identical; only the detection path differs.
 *
 * The integration id is the DIALECT, not the vendor stamp, so both stamps
 * report the same integration.
 */
const openInferenceIntegration: AiIntegration = {
	id: "openinference",
	sources: {
		requestModel: ["llm.model_name"],
		providerName: ["llm.provider", "llm.system"],
		usageInputTokens: ["llm.token_count.prompt"],
		usageOutputTokens: ["llm.token_count.completion"],
		usageCacheReadInputTokens: ["llm.token_count.prompt_details.cache_read"],
		usageReasoningOutputTokens: ["llm.token_count.completion_details.reasoning"],
		inputMessages: ["llm.input_messages", "input.value"],
		outputMessages: ["llm.output_messages", "output.value"],
		toolName: ["tool.name"],
		toolDescription: ["tool.description"],
		toolDefinitions: ["llm.tools"],
	},
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		// `openinference.span.kind` is the dialect's operation classifier, but it
		// is an enum of a different vocabulary rather than a differently named
		// `gen_ai.operation.name`, so translating it is a refine, not an alias.
		if (values.operationName !== undefined) return
		const operation = OPENINFERENCE_SPAN_KIND_OPERATIONS.get(
			ctx.attributes["openinference.span.kind"] ?? "",
		)
		if (operation !== undefined) values.operationName = operation
	},
	refineKeys: ["openinference.span.kind"],
}

/**
 * eve — a session envelope rather than a GenAI dialect: its `ai.eve.turn` spans
 * carry no generation attributes (the model call happens on Vercel AI SDK child
 * spans the gateway stamps separately) and the session id is already lifted
 * into `maple_ai.session.id`, so only the turn id is left to map.
 */
const eveIntegration: AiIntegration = {
	id: "eve",
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		if (values.conversationId !== undefined) return
		const turnId = ctx.attributes["eve.turn.id"]
		if (turnId !== undefined && turnId !== "") values.conversationId = turnId
	},
	refineKeys: ["eve.turn.id"],
}

/**
 * maple — Maple's own native convention (`apps/api` chat + investigations), and
 * the opt-in for any generic emitter that adopts `maple_ai.session.id`. The spans
 * carry canonical `gen_ai.*`, so the default integration decodes them; like eve,
 * only the turn id needs lifting — `maple_ai.turn.id` is the conversation-level
 * grouping key inside a session, kept out of `gen_ai.conversation.id` on the
 * wire because the semconv key names the whole conversation, not one turn.
 * It wins over a `gen_ai.conversation.id` on the same span for that reason: the
 * agent engine stamps its thread id — the session — on the tool spans it opens.
 */
const mapleIntegration: AiIntegration = {
	id: "maple",
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		const turnId = ctx.attributes[MAPLE_NATIVE_TURN_ID_ATTR]
		if (turnId !== undefined && turnId !== "") values.conversationId = turnId
	},
	refineKeys: [MAPLE_NATIVE_TURN_ID_ATTR],
}

/**
 * CrewAI — OpenInference, whose agent spans name the agent's role only in
 * `graph.node.id` unless the GenAI dual-write is on. A vendor-gated refine
 * rather than an alias, because Agno's spans carry an opaque id under that key.
 */
const crewAiIntegration: AiIntegration = {
	id: "crewai",
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		if (values.agentName !== undefined) return
		const role = ctx.attributes[CREWAI_AGENT_NAME_KEY]
		if (role !== undefined && role.trim() !== "") values.agentName = role
	},
	refineKeys: [CREWAI_AGENT_NAME_KEY],
}

/**
 * A dialect that reports time to first token in MILLISECONDS under its own key,
 * lifted into the catalog's `responseTimeToFirstChunk`, which is seconds. A
 * refine rather than an alias because the unit differs.
 */
const msTimeToFirstChunk = (id: string, key: string): AiIntegration => ({
	id,
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		if (values.responseTimeToFirstChunk !== undefined) return
		const ms = Number(ctx.attributes[key])
		if (Number.isFinite(ms) && ms > 0) values.responseTimeToFirstChunk = ms / 1000
	},
	refineKeys: [key],
})

/**
 * Vendor id → override. Every id the gateway can stamp that is NOT in here maps
 * through the default GenAI integration, which is the right answer for the
 * frameworks that emit canonical `gen_ai.*`.
 */
export const AI_VENDOR_INTEGRATIONS = {
	vercel_ai_sdk: vercelAiSdkIntegration,
	"openinference-openai": openInferenceIntegration,
	"unknown:openinference": openInferenceIntegration,
	eve: eveIntegration,
	maple: mapleIntegration,
	crewai: crewAiIntegration,
	// OpenRouter Broadcast: the gateway's own clock, request in to first token out.
	openrouter: msTimeToFirstChunk("openrouter", "trace.metadata.openrouter.first_token_ms"),
	// Strands fills this semconv-named key from the model's `timeToFirstByteMs`.
	strands: msTimeToFirstChunk("strands", "gen_ai.server.time_to_first_token"),
} as const satisfies Record<string, AiIntegration>

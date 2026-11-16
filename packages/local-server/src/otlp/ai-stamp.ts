// Local port of the hosted `maple_ai.*` stamping (apps/ingest/src/ai_session.rs, facts.rs, usage.rs),
// limited to the `maple` and `unknown:genai` tiers. Named vendors, `unknown:openinference`
// and `unknown:other` (openinference, llm.*, legacy ai.* spans) are a follow-up.

import {
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_STAMP_ATTRS as STAMP,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
	MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR,
	MAPLE_GENAI_MODEL_DURATION_MS_ATTR,
	MAPLE_NATIVE_TURN_ID_ATTR,
} from "@maple/domain/gen-ai"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { formatDouble } from "./format-double"

type Attrs = Record<string, string>

const inNamespace = Str.startsWith("maple_ai.")
const isScorerSpan = Str.startsWith("scorer_")
const VENDOR_VERSION = "0"
const CONVERSATION_ID_KEY = "gen_ai.conversation.id"
const PRESERVED_ATTRS: ReadonlySet<string> = new Set([
	MAPLE_NATIVE_TURN_ID_ATTR,
	MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR,
	MAPLE_GENAI_MODEL_DURATION_MS_ATTR,
])
// OTLP enum values: `SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`.
const SPAN_KIND_SERVER = 2
const STATUS_CODE_ERROR = 2

const TOOL_DESCRIPTION_MAX = 2_000
const TOOL_ERROR_RESULT_MAX = 1_000

// Each fact's keys, canonical first: the first non-empty value wins (facts.rs).
const RESPONSE_MODEL_KEYS = ["gen_ai.response.model", "ai.response.model"]
const REQUEST_MODEL_KEYS = ["gen_ai.request.model", "ai.model.id", "llm.model_name"]
const AGENT_NAME_KEYS = ["gen_ai.agent.name", "ai.telemetry.functionId"]
const TOOL_NAME_KEYS = ["gen_ai.tool.name", "ai.toolCall.name", "tool.name"]
const TOOL_DESCRIPTION_KEYS = ["gen_ai.tool.description", "tool.description"]
const TOOL_RESULT_KEYS = ["gen_ai.tool.call.result", "ai.toolCall.result"]
const RESPONSE_ID_KEYS = ["gen_ai.response.id", "ai.response.id"]

// Usage spellings (usage.rs): the first key whose value parses as a number wins.
const INPUT_KEYS = [
	"gen_ai.usage.input_tokens",
	"gen_ai.usage.prompt_tokens",
	"ai.usage.inputTokens",
	"ai.usage.promptTokens",
	"llm.token_count.prompt",
]
const CACHE_READ_KEYS = [
	"gen_ai.usage.cache_read.input_tokens",
	"gen_ai.usage.input_tokens.cached",
	"gen_ai.usage.cache_read_input_tokens",
	"ai.usage.cachedInputTokens",
	"ai.usage.inputTokenDetails.cacheReadTokens",
	"llm.token_count.prompt_details.cache_read",
]
const CACHE_WRITE_KEYS = [
	"gen_ai.usage.cache_creation.input_tokens",
	"gen_ai.usage.cache_write.input_tokens",
	"gen_ai.usage.input_tokens.cache_write",
	"gen_ai.usage.cache_write_input_tokens",
	"ai.usage.inputTokenDetails.cacheWriteTokens",
	"llm.token_count.prompt_details.cache_write",
]
const OUTPUT_KEYS = [
	"gen_ai.usage.output_tokens",
	"gen_ai.usage.completion_tokens",
	"ai.usage.outputTokens",
	"ai.usage.completionTokens",
	"llm.token_count.completion",
]
const REASONING_KEYS = [
	"gen_ai.usage.reasoning.output_tokens",
	"gen_ai.usage.output_tokens.reasoning",
	"gen_ai.usage.reasoning_tokens",
	"gen_ai.usage.details.reasoning_tokens",
	"ai.usage.reasoningTokens",
	"ai.usage.outputTokenDetails.reasoningTokens",
	"llm.token_count.completion_details.reasoning",
]
const UNCACHED_INPUT_KEYS = ["ai.usage.inputTokenDetails.noCacheTokens"]
const VISIBLE_OUTPUT_KEYS = ["ai.usage.outputTokenDetails.textTokens"]
const COST_KEYS = [
	"gen_ai.usage.cost",
	"gen_ai.usage.total_cost",
	"llm.cost.total",
	"litellm.cost.total",
	"operation.cost",
	"openrouter.cost",
]

const INFERENCE_OPS: ReadonlySet<string> = new Set([
	"chat",
	"generate_content",
	"text_completion",
	"fetch_response",
])
const KNOWN_OPS: ReadonlySet<string> = new Set([
	...INFERENCE_OPS,
	"embeddings",
	"retrieval",
	"execute_tool",
	"invoke_agent",
	"create_agent",
	"invoke_workflow",
	"plan",
	"agent_step",
	"search_memory",
	"create_memory",
	"update_memory",
	"upsert_memory",
	"delete_memory",
	"create_memory_store",
	"delete_memory_store",
])

/** Index of the first key holding a non-empty value, or -1. */
function firstIndex(attrs: Attrs, keys: readonly string[]): number {
	for (let i = 0; i < keys.length; i++) {
		const value = attrs[keys[i] ?? ""]
		if (value !== undefined && value !== "") return i
	}
	return -1
}

function firstText(attrs: Attrs, keys: readonly string[]): string {
	const index = firstIndex(attrs, keys)
	return index === -1 ? "" : (attrs[keys[index] ?? ""] ?? "")
}

// Rust's `str::parse::<f64>` grammar after `trim`; its non-finite spellings fail the >= 0 test anyway.
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** The first key whose value is a finite, non-negative number (facts.rs `number`). */
function firstNumber(attrs: Attrs, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const raw = attrs[key]
		if (raw === undefined) continue
		const text = Str.trim(raw)
		if (!DECIMAL.test(text)) continue
		const value = Number(text)
		if (Number.isFinite(value) && value >= 0) return value
	}
	return undefined
}

// Rust lowercases ASCII only; the needles and model names compared here are ASCII.
const lower = Str.toLowerCase

/** Does `name` contain `needle` (lowercase), ignoring case? */
function nameHas(name: string, needle: string): boolean {
	return Str.includes(needle)(lower(name))
}

/** `text` cut to `max` characters (Unicode scalar values, as Rust counts them). */
/** The first `max` code points, scanning no further (tool results can be megabytes). */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	let end = 0
	let count = 0
	for (const char of text) {
		if (count === max) return Str.slice(0, end)(text)
		end += char.length
		count++
	}
	return text
}

const allDigits = (part: string | undefined, len: number) =>
	part !== undefined && part.length === len && /^\d+$/.test(part)

/** A model name without its release date (`-2024-07-18`, `-20251001`), if it has one. */
function stripDate(name: string): string | undefined {
	const parts = Str.split("-")(name)
	const n = parts.length
	if (n >= 4 && allDigits(parts[n - 1], 2) && allDigits(parts[n - 2], 2) && allDigits(parts[n - 3], 4)) {
		return Arr.join(Arr.take(parts, n - 3), "-")
	}
	const tail = parts[n - 1]
	return n >= 2 && allDigits(tail, 8) ? Arr.join(Arr.take(parts, n - 1), "-") : undefined
}

/** facts.rs `same_model`: equal without provider prefix, dots, and an unpinned request's date. */
export function sameModel(request: string, response: string): boolean {
	const base = (model: string) => lower(Str.replaceAll(".", "-")(Arr.lastNonEmpty(Str.split("/")(model))))
	const req = base(request)
	const res = base(response)
	if (req === res) return true
	return stripDate(req) === undefined && stripDate(res) === req
}

const at = (attrs: Attrs, keys: readonly string[], index: number) =>
	index === -1 ? "" : (attrs[keys[index] ?? ""] ?? "")

/** facts.rs `model` (what usage reads) and `stamped_model` (what the stamp names). */
function models(attrs: Attrs): { model: string; stamped: string } {
	const responseRank = firstIndex(attrs, RESPONSE_MODEL_KEYS)
	const requestRank = firstIndex(attrs, REQUEST_MODEL_KEYS)
	const response = at(attrs, RESPONSE_MODEL_KEYS, responseRank)
	const request = at(attrs, REQUEST_MODEL_KEYS, requestRank)
	const model = responseRank > 0 && requestRank === 0 ? request : responseRank !== -1 ? response : request
	const stamped = response !== "" && request !== "" && sameModel(request, response) ? request : model
	return { model, stamped }
}

/** `gen_ai.operation.name`, else the OpenInference span kind translated. */
function operation(attrs: Attrs): string {
	const op = attrs["gen_ai.operation.name"] ?? ""
	if (op !== "") return op
	switch (attrs["openinference.span.kind"]) {
		case "LLM":
			return "chat"
		case "TOOL":
			return "execute_tool"
		case "AGENT":
			return "invoke_agent"
		case "EMBEDDING":
			return "embeddings"
		case "RETRIEVER":
			return "retrieval"
		default:
			return ""
	}
}

const hasToolName = (attrs: Attrs) => firstIndex(attrs, TOOL_NAME_KEYS) !== -1

/** usage.rs `is_model_call`, for the two vendors this port detects. */
function isModelCall(
	vendor: string,
	op: string,
	attrs: Attrs,
	spanName: string,
	kind: number | undefined,
	model: string,
) {
	if (INFERENCE_OPS.has(op)) return true
	if (!Str.startsWith("unknown:")(vendor) || kind === SPAN_KIND_SERVER) return false
	// `named_like_a_model_call`: an op outside the convention, not a tool, agent or workflow.
	if (KNOWN_OPS.has(op)) return false
	if (hasToolName(attrs) || (op === "" && nameHas(spanName, "tool"))) return false
	if (nameHas(spanName, "agent") || nameHas(spanName, "workflow")) return false
	return model !== "" || nameHas(spanName, "chat") || nameHas(spanName, "completion")
}

/** usage.rs `stamp` for a model call: five disjoint token buckets (zero left absent) and the cost. */
function stampUsage(attrs: Attrs, out: Attrs): void {
	const count = (keys: readonly string[]) => {
		const value = firstNumber(attrs, keys)
		return value === undefined ? undefined : Math.trunc(value)
	}
	const prompt = count(INPUT_KEYS) ?? 0
	const cacheRead = count(CACHE_READ_KEYS) ?? 0
	const cacheWrite = count(CACHE_WRITE_KEYS) ?? 0
	const completion = count(OUTPUT_KEYS) ?? 0
	// An inclusive prompt cannot be smaller than the cache it contains.
	const cache = cacheRead + cacheWrite
	const excludesCache = cache > prompt
	// The completion contains the reasoning, clamped to it.
	const reasoning = Math.min(count(REASONING_KEYS) ?? 0, completion)
	const buckets: ReadonlyArray<readonly [string, number]> = [
		[STAMP.inputTokens, count(UNCACHED_INPUT_KEYS) ?? (excludesCache ? prompt : prompt - cache)],
		[STAMP.cacheReadTokens, cacheRead],
		[STAMP.cacheWriteTokens, cacheWrite],
		[STAMP.outputTokens, count(VISIBLE_OUTPUT_KEYS) ?? completion - reasoning],
		[STAMP.reasoningTokens, reasoning],
	]
	for (const [key, value] of buckets) {
		if (value > 0) out[key] = formatDouble(value)
	}
	const cost = firstNumber(attrs, COST_KEYS)
	if (cost !== undefined) out[STAMP.cost] = formatDouble(cost)
}

/** facts.rs `is_tool_call`. */
function isToolCall(op: string, attrs: Attrs, spanName: string): boolean {
	return (
		op === "execute_tool" ||
		(!KNOWN_OPS.has(op) && (hasToolName(attrs) || (op === "" && nameHas(spanName, "tool"))))
	)
}

/** ai_session.rs `run_predicates`, limited to `maple` and the `unknown:genai` tier. */
function classify(attrs: Attrs, kind: number | undefined): string | undefined {
	// A Mastra scorer run is an evaluation, and an MCP server span is the tool, not an agent.
	if (
		attrs["mastra.metadata.targetTraceId"] !== undefined ||
		isScorerSpan(attrs["mastra.span.type"] ?? "")
	) {
		return undefined
	}
	if (kind === SPAN_KIND_SERVER && attrs["mcp.method.name"] !== undefined) return undefined
	if (attrs[MAPLE_AI_SESSION_ID_ATTR] !== undefined) return "maple"
	if (attrs["gen_ai.operation.name"] !== undefined && attrs["openinference.span.kind"] === undefined) {
		return "unknown:genai"
	}
	return undefined
}

/**
 * Stamp the `maple_ai.*` keys the hosted gateway writes onto one span's attribute map.
 * Returns the map to encode: the same object, or a copy with client-sent `maple_ai.*`
 * keys stripped (the gateway owns that namespace, except `PRESERVED_ATTRS`).
 */
export function stampAiSpan(
	attrs: Attrs,
	spanName: string,
	kind: number | undefined,
	statusCode: number | undefined,
): Attrs {
	let namespaced = false
	for (const key in attrs) {
		if (inNamespace(key)) {
			namespaced = true
			break
		}
	}
	// Differs from Rust, which re-derives: this port lacks most vendors, so an upstream stamp is kept.
	if (namespaced && (attrs[MAPLE_AI_VENDOR_ID_ATTR] ?? "") !== "") return attrs
	const vendor = classify(attrs, kind)
	const nativeSession = attrs[MAPLE_AI_SESSION_ID_ATTR] ?? ""
	const out = namespaced
		? Rec.filter(attrs, (_, key) => !inNamespace(key) || PRESERVED_ATTRS.has(key))
		: attrs
	if (vendor === undefined) return out

	const session = (vendor === "maple" ? nativeSession : "") || (attrs[CONVERSATION_ID_KEY] ?? "")
	out[MAPLE_AI_VENDOR_ID_ATTR] = vendor
	out[MAPLE_AI_VENDOR_VERSION_ATTR] = VENDOR_VERSION
	if (session !== "") out[MAPLE_AI_SESSION_ID_ATTR] = session

	const op = operation(attrs)
	const { model, stamped } = models(attrs)
	const llmCall = isModelCall(vendor, op, attrs, spanName, kind, model)
	out[STAMP.llmCall] = llmCall ? "1" : "0"
	if (llmCall) stampUsage(attrs, out)
	const toolCall = !llmCall && isToolCall(op, attrs, spanName)
	const responseStatus = lower(attrs["gen_ai.response.status"] ?? "")
	const failed =
		statusCode === STATUS_CODE_ERROR ||
		(attrs["error.type"] ?? "") !== "" ||
		responseStatus === "failed" ||
		responseStatus === "error"

	const text = (key: string, value: string) => {
		if (value !== "") out[key] = value
	}
	text(STAMP.model, stamped)
	text(STAMP.agentName, firstText(attrs, AGENT_NAME_KEYS))
	text(STAMP.toolName, firstText(attrs, TOOL_NAME_KEYS))
	if (llmCall) text(STAMP.responseId, firstText(attrs, RESPONSE_ID_KEYS))
	if (toolCall) {
		text(STAMP.toolDescription, truncate(firstText(attrs, TOOL_DESCRIPTION_KEYS), TOOL_DESCRIPTION_MAX))
		if (failed)
			text(STAMP.toolErrorResult, truncate(firstText(attrs, TOOL_RESULT_KEYS), TOOL_ERROR_RESULT_MAX))
		// Paused-for-approval copies (`0`) are vendor-specific; neither tier here has one.
		out[STAMP.toolCall] = "1"
	}
	if (failed) out[STAMP.error] = "1"
	return out
}

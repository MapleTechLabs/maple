import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import {
	GENAI_AGENT_NAME_KEYS,
	GENAI_COST_KEYS,
	GENAI_MODEL_KEYS,
	GENAI_PROVIDER_LEGACY_VALUES,
	GENAI_PROVIDER_NAME_KEYS,
	GENAI_RESPONSE_ID_KEYS,
	GENAI_ERROR_TYPE_KEYS,
	GENAI_TOOL_CALL_RESULT_KEYS,
	GENAI_TOOL_DESCRIPTION_KEYS,
	GENAI_TOOL_NAME_KEYS,
	GENAI_USAGE_KEYS,
	OPENINFERENCE_KIND_OPERATIONS,
	genAiIsErrorCond,
	genAiIsLlmCallCond,
	genAiIsToolCallCond,
	genAiOperationExpr,
	genAiTokensExpr,
} from "@maple/domain/tinybird/gen-ai-columns"
import {
	GENAI_PROVIDER_USAGE_CONVENTIONS,
	type AiGenAiField,
	type MutableAiGenAiValues,
} from "@maple/domain/gen-ai"
import { LEGACY_SYSTEM_VALUES, genAiIntegration, resolveAiIntegration } from "./ai-integrations"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"
import {
	childClaimsExpr,
	nettedReportersExpr,
	reporterSpanIdsExpr,
	sessionLlmCalls,
	sessionReportersExpr,
	sessionUsageSum,
	usageLinksExpr,
	usageReportersExpr,
} from "./ai-span-columns"

/** Every key any integration reads for `field` — the default's plus each vendor's. */
const decodedKeys = (field: AiGenAiField): ReadonlySet<string> =>
	new Set([
		...genAiIntegration.sources[field],
		...Object.keys(AI_VENDOR_INTEGRATIONS).flatMap(
			(vendorId) => resolveAiIntegration(vendorId).sources[field],
		),
	])

const attrs = {
	get: (key: string) => CH.mapGet(CH.dynamicColumn<Record<string, string>>("SpanAttributes"), key),
}
const columns = {
	SpanName: CH.dynamicColumn<string>("SpanName", T.string),
	StatusCode: CH.dynamicColumn<string>("StatusCode", T.string),
	SpanAttributes: attrs,
}
const sql = (expr: { toFragment(): Parameters<typeof compile>[0] }) => compile(expr.toFragment())

// The SQL lists are hand-copied from the integration layer's alias tables,
// because the index's MV cannot call into it. These pin every list to that
// layer, so a key that decodes on the detail page is one the list can filter
// on — and one the list reads that nothing decodes is a typo caught here.
describe("GenAI column key lists match the integration layer", () => {
	it("model: response and request model keys", () => {
		const decoded = new Set([...decodedKeys("responseModel"), ...decodedKeys("requestModel")])
		for (const key of GENAI_MODEL_KEYS) expect(decoded).toContain(key)
	})

	it("agent and tool names, and the response id the session dedupes on", () => {
		for (const key of GENAI_AGENT_NAME_KEYS) expect(decodedKeys("agentName")).toContain(key)
		for (const key of GENAI_TOOL_NAME_KEYS) expect(decodedKeys("toolName")).toContain(key)
		for (const key of GENAI_RESPONSE_ID_KEYS) expect(decodedKeys("responseId")).toContain(key)
		for (const key of decodedKeys("responseId")) expect(GENAI_RESPONSE_ID_KEYS).toContain(key)
	})

	// Both directions, in both lists: the tool detail page groups its failures by
	// the index's `ErrorType` and renders the index's `ToolDescription`, so a key
	// only one side reads is a failure the page files under `unknown` or a
	// description it never shows. The index's `FailedToolCallResult` and the
	// `ErrorFingerprint` hashed from it read the call's result the same way, or a
	// failure explained only there is grouped by an empty status message.
	it("the failure's type, the call's result and the tool's description, exactly", () => {
		expect([...GENAI_ERROR_TYPE_KEYS]).toEqual([...decodedKeys("errorType")])
		expect([...GENAI_TOOL_CALL_RESULT_KEYS]).toEqual([...decodedKeys("toolCallResult")])
		expect([...GENAI_TOOL_DESCRIPTION_KEYS]).toEqual([...decodedKeys("toolDescription")])
	})

	it("every usage bucket and the cost, bucket for bucket", () => {
		const fields = {
			input: "usageInputTokens",
			cacheRead: "usageCacheReadInputTokens",
			cacheWrite: "usageCacheCreationInputTokens",
			output: "usageOutputTokens",
			reasoning: "usageReasoningOutputTokens",
		} as const
		for (const [bucket, field] of Object.entries(fields)) {
			const decoded = decodedKeys(field)
			for (const key of GENAI_USAGE_KEYS[bucket as keyof typeof GENAI_USAGE_KEYS]) {
				expect(decoded, `${bucket}: ${key}`).toContain(key)
			}
			// And the other way: the list reads every key the detail page decodes,
			// so a session's tokens cannot be counted on one page and not the other.
			for (const key of decoded) {
				expect(
					GENAI_USAGE_KEYS[bucket as keyof typeof GENAI_USAGE_KEYS],
					`${bucket}: ${key}`,
				).toContain(key)
			}
		}
		for (const key of GENAI_COST_KEYS) expect(decodedKeys("usageCost")).toContain(key)
		for (const key of decodedKeys("usageCost")) expect(GENAI_COST_KEYS).toContain(key)
	})

	it("the provider that decides the usage convention, and its legacy spellings", () => {
		for (const key of GENAI_PROVIDER_NAME_KEYS) expect(decodedKeys("providerName")).toContain(key)
		for (const key of decodedKeys("providerName")) expect(GENAI_PROVIDER_NAME_KEYS).toContain(key)
		// The view matches the pre-rename `gen_ai.system` values the read side
		// canonicalises, for every provider the convention table names.
		for (const [canonical, legacy] of GENAI_PROVIDER_LEGACY_VALUES) {
			expect(LEGACY_SYSTEM_VALUES.get(legacy)).toBe(canonical)
		}
		for (const [legacy, canonical] of LEGACY_SYSTEM_VALUES) {
			if (!GENAI_PROVIDER_USAGE_CONVENTIONS.has(canonical)) continue
			expect(GENAI_PROVIDER_LEGACY_VALUES.map(([, value]) => value)).toContain(legacy)
		}
	})

	it("translates the OpenInference span kinds the integration refines", () => {
		const integration = resolveAiIntegration("openinference-openai")
		for (const [kind, operation] of OPENINFERENCE_KIND_OPERATIONS) {
			const values: MutableAiGenAiValues = {}
			integration.refine?.(values, {
				attributes: { "openinference.span.kind": kind },
				row: {} as never,
				read: () => undefined,
			})
			expect(values.operationName, kind).toBe(operation)
		}
	})
})

describe("span classification SQL", () => {
	it("reads the operation from gen_ai.operation.name, else the OpenInference kind", () => {
		expect(sql(genAiOperationExpr(attrs))).toBe(
			"coalesce(nullIf(SpanAttributes['gen_ai.operation.name'], ''), multiIf(SpanAttributes['openinference.span.kind'] = 'LLM', 'chat', SpanAttributes['openinference.span.kind'] = 'TOOL', 'execute_tool', SpanAttributes['openinference.span.kind'] = 'AGENT', 'invoke_agent', SpanAttributes['openinference.span.kind'] = 'EMBEDDING', 'embeddings', SpanAttributes['openinference.span.kind'] = 'RETRIEVER', 'retrieval', ''))",
		)
	})

	it("counts a model turn by operation, or by name only for an unclassified agent span", () => {
		const text = sql(genAiIsLlmCallCond(columns))
		expect(text).toContain("IN ('chat', 'generate_content', 'text_completion', 'fetch_response')")
		// The name rules apply only where the operation is absent or unknown to
		// the convention, only to vendor-stamped spans, and only after the tool
		// and agent rules have declined — the client's order.
		expect(text).toContain(
			"NOT IN ('chat', 'generate_content', 'text_completion', 'fetch_response', 'embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step')",
		)
		expect(text).toContain("NOT ((coalesce(nullIf(SpanAttributes['gen_ai.tool.name'], '')")
		expect(text).toContain("lower(SpanName) LIKE '%tool%'")
		expect(text).toContain("NOT ((lower(SpanName) LIKE '%agent%' OR lower(SpanName) LIKE '%workflow%'))")
		expect(text).toContain("lower(SpanName) LIKE '%chat%' OR lower(SpanName) LIKE '%completion%'")
	})

	it("counts a tool call by operation, or by a tool name / tool-ish span name", () => {
		const text = sql(genAiIsToolCallCond(columns))
		expect(text).toContain("IN ('execute_tool')")
		expect(text).toContain("SpanAttributes['tool.name']) != '' OR lower(SpanName) LIKE '%tool%'")
	})

	it("sums the token buckets under the reporter's convention, each coalesced canonical-first", () => {
		const text = sql(genAiTokensExpr(attrs))
		// The prompt half: the cache buckets nest in the prompt figure for the
		// re-summing vendors and the OpenAI-shaped providers, and sit beside it
		// for Anthropic; the default nests.
		expect(text).toContain(
			"multiIf(SpanAttributes['maple_ai.vendor.id'] IN ('vercel_ai_sdk', 'maple'), greatest(",
		)
		expect(text).toContain(
			"IN ('openai', 'gcp.gemini', 'gemini', 'gcp.vertex_ai', 'vertex_ai', 'openrouter'), greatest(",
		)
		expect(text).toContain(
			"IN ('anthropic'), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens']",
		)
		// The completion half: reasoning nests for Anthropic and the OpenAI-shaped
		// providers, and sits beside the completion for Gemini.
		expect(text).toContain("IN ('anthropic', 'openai', 'openrouter'), greatest(")
		expect(text).toContain(
			"IN ('gcp.gemini', 'gemini', 'gcp.vertex_ai', 'vertex_ai'), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens']",
		)
		// Every bucket is read canonical-first, down to the OpenInference spelling.
		expect(text).toContain("coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], '')")
		expect(text).toContain("SpanAttributes['llm.token_count.completion_details.reasoning']))")
	})

	it("flags a failure by status or by a declared failure attribute", () => {
		expect(sql(genAiIsErrorCond(columns))).toBe(
			"((StatusCode = 'Error' OR SpanAttributes['error.type'] != '') OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))",
		)
	})

	it("collects a trace's reporters and model calls, capped", () => {
		const reporters = usageReportersExpr({
			SpanId: CH.dynamicColumn<string>("SpanId", T.string),
			ParentSpanId: CH.dynamicColumn<string>("ParentSpanId", T.string),
			Tokens: CH.dynamicColumn<number>("Tokens", T.float64),
			Cost: CH.dynamicColumn<number>("Cost", T.float64),
			ResponseId: CH.dynamicColumn<string>("ResponseId", T.string),
			IsLlmCall: CH.dynamicColumn<number>("IsLlmCall", T.uint8),
			InputTokens: CH.dynamicColumn<number>("InputTokens", T.float64),
			CacheReadTokens: CH.dynamicColumn<number>("CacheReadTokens", T.float64),
			CacheWriteTokens: CH.dynamicColumn<number>("CacheWriteTokens", T.float64),
			OutputTokens: CH.dynamicColumn<number>("OutputTokens", T.float64),
			ReasoningTokens: CH.dynamicColumn<number>("ReasoningTokens", T.float64),
		})
		// The five buckets ride along as elements 7–11; a span reports by its
		// total or cost, which the buckets sum to, so they add no predicate.
		expect(sql(reporters)).toBe(
			"groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost, ResponseId, IsLlmCall, InputTokens, CacheReadTokens, CacheWriteTokens, OutputTokens, ReasoningTokens), ((Tokens > 0 OR Cost > 0) OR IsLlmCall = 1))",
		)
	})

	it("maps each of a trace's spans to itself when it reported the measure, else to its parent", () => {
		const links = usageLinksExpr(
			{
				SpanId: CH.dynamicColumn<string>("SpanId", T.string),
				ParentSpanId: CH.dynamicColumn<string>("ParentSpanId", T.string),
			},
			CH.dynamicColumn<number>("Cost", T.float64),
		)
		expect(sql(links)).toBe(
			"CAST(groupArray(2000)(tuple(SpanId, if(Cost > 0, SpanId, ParentSpanId))), 'Map(String, String)')",
		)
	})

	it("collects the session's reporters once, and the two lookups the netting makes off them", () => {
		// Each reporter carries the nearest ancestor that reported tokens (12) and
		// the nearest that reported a cost (13), climbed off its trace's links.
		const climb = (links: string) => `${`${links}[`.repeat(4)}r.2${"]".repeat(4)}`
		expect(sql(sessionReportersExpr("usageReporters", "tokenLinks", "costLinks"))).toBe(
			`arraySlice(arrayFlatten(groupArray(arrayMap(r -> tupleConcat(r, tuple(${climb("tokenLinks")}, ${climb("costLinks")})), usageReporters))), 1, 2000)`,
		)
		// What the reporters charged to each one already claimed: one sumMap
		// over the reporters, each entered under its token ancestor with its
		// tokens and under its cost ancestor with its cost.
		expect(sql(childClaimsExpr("reporters"))).toBe(
			"arrayReduce('sumMap', arrayMap(c -> [c.12, c.13], reporters), arrayMap(c -> [c.3, 0.], reporters), arrayMap(c -> [0., c.4], reporters), arrayMap(c -> [c.7, 0.], reporters), arrayMap(c -> [c.8, 0.], reporters), arrayMap(c -> [c.9, 0.], reporters), arrayMap(c -> [c.10, 0.], reporters), arrayMap(c -> [c.11, 0.], reporters))",
		)
		expect(sql(reporterSpanIdsExpr("reporters"))).toBe("tupleElement(reporters, 1)")
	})

	it("nets every claim in one pass: children off their parent, a call at its deepest account", () => {
		const text = sql(nettedReportersExpr("reporters", "childClaims", "reporterIds"))
		const charged = (element: number) =>
			`arrayElement(tupleElement(childClaims, ${element}), indexOf(tupleElement(childClaims, 1), r.1))`

		expect(text).toMatch(/^arrayMap\(r -> tuple\(r\.5, /)
		expect(text).toMatch(/, reporters\)$/)
		// A reporting call counts by its netted claim; a non-reporting one by
		// having no reporting ancestor and no model call for a parent.
		expect(text).toContain(
			`r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - ${charged(2)}) > 0 OR greatest(0., r.4 - ${charged(3)}) > 0, NOT has(reporterIds, r.12) AND NOT has(reporterIds, r.13) AND NOT has(reporterIds, r.2))`,
		)
		// Tokens, cost and the five buckets, each less its children's, floored at
		// zero — and nothing at all for a reporter that is not a model call once
		// that measure was charged to it (tokens decide the buckets).
		for (const [element, child, measure] of [
			[3, 2, 2],
			[4, 3, 3],
			[7, 4, 2],
			[8, 5, 2],
			[9, 6, 2],
			[10, 7, 2],
			[11, 8, 2],
		] as const) {
			expect(text).toContain(
				`if(r.6 = 0 AND ${charged(measure)} > 0, 0., greatest(0., r.${element} - ${charged(child)}))`,
			)
		}
		// One lambda over the reporters, and none inside it searching them again.
		expect(text.split("->").length - 1).toBe(1)
	})

	it.each([
		["tokens", 3],
		["cost", 4],
		["inputTokens", 5],
		["reasoningTokens", 9],
	] as const)(
		"sums the netted claims: every unkeyed one, and the largest per response id (%s)",
		(measure, element) => {
			expect(sql(sessionUsageSum("netted", measure))).toBe(
				`arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), ${element})) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.${element}), arrayFilter(n -> n.1 != '', netted)))))`,
			)
		},
	)

	it("counts the model calls the same way, off the netted flag", () => {
		expect(sql(sessionLlmCalls("netted"))).toBe(
			"toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted))))))",
		)
	})
})

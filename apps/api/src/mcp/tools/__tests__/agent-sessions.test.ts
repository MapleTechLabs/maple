// SAFETY-FILE: the fixtures below are warehouse rows this test authors itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Schema } from "effect"
import type { McpToolRequirements } from "@/mcp/tools/runtime-requirements"
import type { McpToolRegistrar, McpToolResult } from "@/mcp/tools/types"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import { registerGetAgentSessionTool } from "@/mcp/tools/get-agent-session"
import { registerGetAgentSessionTranscriptTool } from "@/mcp/tools/get-agent-session-transcript"
import { registerListAgentSessionSpansTool } from "@/mcp/tools/list-agent-session-spans"
import { registerListAgentSessionsTool } from "@/mcp/tools/list-agent-sessions"
import { registerInspectAgentSessionSpanTool } from "@/mcp/tools/inspect-agent-session-span"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "@/mcp/__evals__/fake-warehouse"
import { makeEvalRuntime, runToolDirect, type EvalRuntime } from "@/mcp/__evals__/eval-runtime"

const SESSION_ID = "wrun_01KZTEST"
const EMPTY_SESSION_ID = "wrun_01KZEMPTY"
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const WINDOW = { start_time: "2026-08-19 09:00:00", end_time: "2026-08-19 12:00:00" }

/* -------------------------------------------------------------------------- */
/* Registration + parameter validation                                        */
/* -------------------------------------------------------------------------- */

type ToolInput = Record<string, string | number | boolean | undefined>

const captureTool = (register: (server: McpToolRegistrar) => void) => {
	let captured:
		| {
				name: string
				schema: Schema.Top
				handler: (params: ToolInput) => Effect.Effect<McpToolResult, unknown, unknown>
		  }
		| undefined
	register({
		tool: (name, _description, schema, handler) => {
			// SAFETY: the registrar erases the parameter type; every input below is
			// shaped by the tool's own Struct.
			captured = { name, schema, handler: (params) => handler(params as never) }
		},
	})
	if (!captured) throw new Error("tool did not register")
	return captured
}

// The validation paths below return before any service is read, so an empty
// context is enough.
const run = (effect: Effect.Effect<McpToolResult, unknown, unknown>) =>
	Effect.runPromise(
		(effect as Effect.Effect<McpToolResult, unknown, McpToolRequirements>).pipe(
			Effect.provide(Context.empty() as Context.Context<McpToolRequirements>),
		),
	)

const text = (result: McpToolResult) => result.content.map((c) => ("text" in c ? c.text : "")).join("\n")

const AGENT_SESSION_TOOLS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["list_agent_sessions", []],
	["get_agent_sessions_overview", []],
	["get_agent_session", ["session_id"]],
	["get_agent_session_transcript", ["session_id"]],
	["list_agent_session_spans", ["session_id"]],
	["inspect_agent_session_span", ["session_id", "trace_id", "span_id"]],
]

describe("agent session tool registration", () => {
	it("registers all six with object input schemas and the expected required params", () => {
		for (const [name, required] of AGENT_SESSION_TOOLS) {
			const definition = mapleToolCatalog.find((entry) => entry.name === name)
			expect(definition, name).toBeDefined()
			const schema = toInputSchema(definition!.schema)
			expect(schema.type, name).toBe("object")
			expect(schema.required ?? [], name).toEqual(required)
		}
	})

	it("opens every description by saying these are AI agent sessions", () => {
		for (const [name] of AGENT_SESSION_TOOLS) {
			const definition = mapleToolCatalog.find((entry) => entry.name === name)!
			expect(definition.description, name).toMatch(/AI agent session/i)
		}
	})

	it("points the browser-replay tools at the agent-session tools", () => {
		for (const name of ["search_sessions", "get_session_transcript", "get_session_traces"]) {
			const definition = mapleToolCatalog.find((entry) => entry.name === name)!
			expect(definition.description.startsWith("Browser session replays"), name).toBe(true)
			expect(definition.description, name).toContain("list_agent_sessions")
		}
	})
})

describe("agent session parameter validation", () => {
	it("rejects a lone window bound — the pair is what makes the read a seek", async () => {
		const tool = captureTool(registerGetAgentSessionTool)
		const result = await run(tool.handler({ session_id: SESSION_ID, start_time: "2026-08-19 09:00:00" }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("start_time and end_time are a pair")
	})

	it("rejects a turns selection it cannot read", async () => {
		const tool = captureTool(registerGetAgentSessionTranscriptTool)
		const result = await run(tool.handler({ session_id: SESSION_ID, turns: "the middle bit" }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid turns")
	})

	it("rejects half a keyset cursor", async () => {
		const tool = captureTool(registerListAgentSessionSpansTool)
		const result = await run(tool.handler({ session_id: SESSION_ID, after_span_id: "1111111111111111" }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("after_timestamp and after_span_id are a pair")
	})

	it("rejects an unknown scope and an unknown sort key", async () => {
		const spans = captureTool(registerListAgentSessionSpansTool)
		const scope = await run(spans.handler({ session_id: SESSION_ID, scope: "agent" }))
		expect(scope.isError).toBe(true)
		expect(text(scope)).toContain("Invalid scope")

		const list = captureTool(registerListAgentSessionsTool)
		const sort = await run(list.handler({ sort_by: "spend" }))
		expect(sort.isError).toBe(true)
		expect(text(sort)).toContain("Invalid sort_by")
	})

	it("rejects a trace id that is not 32 hex characters", async () => {
		const tool = captureTool(registerInspectAgentSessionSpanTool)
		const result = await run(
			tool.handler({ session_id: SESSION_ID, trace_id: "7f3a4b5c", span_id: "1111111111111111" }),
		)
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid trace_id")
	})
})

/* -------------------------------------------------------------------------- */
/* Rendering, against warehouse rows in their wire shapes                     */
/* -------------------------------------------------------------------------- */

const listRow = {
	sessionId: SESSION_ID,
	vendorId: "eve",
	vendorVersion: "1",
	traceCount: 1,
	spanCount: 4,
	errorAgentSpans: 1,
	toolErrors: 1,
	turnErrors: 0,
	serviceNames: ["agent-runner"],
	models: ["gpt-5"],
	agentNames: ["maple"],
	firstAgentName: "maple",
	llmCalls: 2,
	toolCalls: 1,
	totalTokens: 1_600,
	inputTokens: 1_200,
	cacheReadTokens: 100,
	cacheWriteTokens: 0,
	outputTokens: 300,
	reasoningTokens: 0,
	cost: 0.02,
	agentStart: "2026-08-19 10:00:00.000000000",
	agentEnd: "2026-08-19 10:00:05.000000000",
	agentDurationMs: 5_000,
}

const facetRows = [
	{ facetType: "vendor", name: "eve", count: 3 },
	{ facetType: "service", name: "agent-runner", count: 3 },
	{ facetType: "environment", name: "production", count: 3 },
	{ facetType: "model", name: "gpt-5", count: 2 },
	{ facetType: "agent", name: "maple", count: 3 },
	{ facetType: "tool", name: "run_sql", count: 2 },
]

const distributionRows = [
	{ measure: "durationMs", buckets: { "1000": 2, "10000": 1 }, p50: 4_200, p95: 31_000 },
	{ measure: "totalTokens", buckets: { "1000": 3 }, p50: 1_600, p95: 9_000 },
]

/** One `trace_detail_spans` row, in the wire shape `aiSessionSpansRowSchema` decodes. */
const spanRow = (
	spanId: string,
	parentSpanId: string,
	spanName: string,
	timestamp: string,
	durationMs: number,
	statusCode: string,
	spanAttributes: Record<string, string>,
) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId,
	spanName,
	spanKind: "SPAN_KIND_INTERNAL",
	serviceName: "agent-runner",
	durationMs,
	statusCode,
	statusMessage: statusCode === "Error" ? "tool call failed" : "",
	timestamp,
	spanAttributes: {
		"maple_ai.session.id": SESSION_ID,
		"maple_ai.vendor.id": "eve",
		"maple_ai.vendor.version": "1",
		...spanAttributes,
	},
})

const sessionSpanRows = [
	spanRow("1111111111111111", "", "invoke_agent maple", "2026-08-19 10:00:00.000000000", 5_000, "Unset", {
		"gen_ai.operation.name": "invoke_agent",
		"gen_ai.agent.name": "maple",
	}),
	spanRow(
		"2222222222222222",
		"1111111111111111",
		"chat gpt-5",
		"2026-08-19 10:00:00.500000000",
		1_200,
		"Unset",
		{
			"gen_ai.operation.name": "chat",
			"gen_ai.request.model": "gpt-5",
			"gen_ai.response.model": "gpt-5",
			"gen_ai.usage.input_tokens": "1200",
			"gen_ai.usage.output_tokens": "300",
			"gen_ai.usage.cache_read.input_tokens": "100",
			"gen_ai.usage.cost": "0.02",
			"gen_ai.input.messages": JSON.stringify([
				{ role: "user", parts: [{ type: "text", content: "why is checkout failing?" }] },
			]),
			"gen_ai.output.messages": JSON.stringify([
				{
					role: "assistant",
					parts: [
						{ type: "tool_call", id: "call_1", name: "run_sql", arguments: { sql: "select 1" } },
					],
				},
			]),
		},
	),
	spanRow(
		"3333333333333333",
		"1111111111111111",
		"execute_tool run_sql",
		"2026-08-19 10:00:02.000000000",
		800,
		"Error",
		{
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "run_sql",
			"gen_ai.tool.call.id": "call_1",
			"gen_ai.tool.call.arguments": JSON.stringify({ sql: "select 1" }),
			"gen_ai.tool.call.result": JSON.stringify({ error: "table orders does not exist" }),
			"error.type": "tool_error",
		},
	),
	spanRow(
		"4444444444444444",
		"1111111111111111",
		"chat gpt-5",
		"2026-08-19 10:00:03.000000000",
		900,
		"Unset",
		{
			"gen_ai.operation.name": "chat",
			"gen_ai.response.model": "gpt-5",
			"gen_ai.usage.input_tokens": "1400",
			"gen_ai.usage.output_tokens": "120",
			"gen_ai.output.messages": JSON.stringify([
				{ role: "assistant", parts: [{ type: "text", content: "the orders table is missing" }] },
			]),
		},
	),
]

// First match wins: the three `ai_trace_index` reads are told apart by the
// derived tables their SQL names.
const fixtures: FixtureRule[] = [
	{ match: (sql) => sql.includes(EMPTY_SESSION_ID), rows: [] },
	{ match: (sql) => sql.includes("facet_traces"), rows: facetRows },
	{ match: (sql) => sql.includes("measured_sessions"), rows: distributionRows },
	{ match: (sql) => sql.includes("trace_detail_spans"), rows: sessionSpanRows },
	{
		match: (sql) => /\bfrom\s+traces\b/i.test(sql),
		rows: [
			{
				startTime: "2026-08-18 10:00:00.000000000",
				endTime: "2026-08-20 10:00:05.000000000",
				spanCount: 4,
			},
		],
	},
	{ match: (sql) => sql.includes("ai_trace_index"), rows: [listRow] },
]

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const rendered = async (name: string, params: Record<string, unknown>): Promise<string> => {
	const result = (await runToolDirect(rt, name, params)) as McpToolResult
	return text(result)
}

describe("list_agent_sessions rendering", () => {
	it("renders the row and hands the session's own window to the next step", async () => {
		const output = await rendered("list_agent_sessions", { ...WINDOW })
		expect(output).toContain(SESSION_ID)
		expect(output).toContain("maple")
		expect(output).toContain("1/1/0")
		expect(output).toContain("get_agent_session")
		// The end bound is rounded up to the whole second: truncating it would cut
		// the session's last spans out of the follow-up read.
		expect(output).toContain('start_time="2026-08-19 10:00:00" end_time="2026-08-19 10:00:05"')
	})
})

describe("get_agent_sessions_overview rendering", () => {
	it("renders the facets and the percentiles", async () => {
		const output = await rendered("get_agent_sessions_overview", { ...WINDOW })
		expect(output).toContain("### Vendors")
		expect(output).toContain("run_sql")
		expect(output).toContain("p50")
		expect(output).toContain("p95")
		expect(output).toContain("4.20s")
	})
})

describe("get_agent_session rendering", () => {
	it("renders the verdict, findings, tokens and tools of a failed session", async () => {
		const output = await rendered("get_agent_session", { session_id: SESSION_ID, ...WINDOW })
		expect(output).toContain("### Verdict")
		expect(output).toContain("tool_error")
		expect(output).toContain("### Tokens")
		expect(output).toContain("### Tools")
		expect(output).toContain("run_sql")
		expect(output).toContain("2 LLM calls")
		expect(output).toContain("inspect_agent_session_span")
		expect(output).toContain(TRACE_ID)
	})

	it("answers an unknown session without inventing one", async () => {
		const output = await rendered("get_agent_session", { session_id: EMPTY_SESSION_ID, ...WINDOW })
		expect(output).toContain("No spans for AI agent session")
	})
})

describe("get_agent_session_transcript rendering", () => {
	it("renders the user, assistant and tool rows", async () => {
		const output = await rendered("get_agent_session_transcript", { session_id: SESSION_ID, ...WINDOW })
		expect(output).toContain("[user]")
		expect(output).toContain("why is checkout failing?")
		expect(output).toContain("[tool run_sql]")
		expect(output).toContain("table orders does not exist")
		expect(output).toContain("[assistant]")
	})

	it("honours a turn selection that no turn matches", async () => {
		const output = await rendered("get_agent_session_transcript", {
			session_id: SESSION_ID,
			...WINDOW,
			turns: "7-9",
		})
		expect(output).toContain("turns=7-9 selects none")
	})
})

describe("list_agent_session_spans rendering", () => {
	it("lists the page with its ids and marks the failed span", async () => {
		const output = await rendered("list_agent_session_spans", { session_id: SESSION_ID, ...WINDOW })
		expect(output).toContain("3333333333333333")
		expect(output).toContain("FAILED")
		expect(output).toContain("inference")
		expect(output).toContain("inspect_agent_session_span")
	})
})

describe("inspect_agent_session_span rendering", () => {
	it("renders the messages and the tool call, with the result resolved from the trace", async () => {
		const output = await rendered("inspect_agent_session_span", {
			session_id: SESSION_ID,
			trace_id: TRACE_ID,
			span_id: "2222222222222222",
			...WINDOW,
		})
		expect(output).toContain("### Messages")
		expect(output).toContain("why is checkout failing?")
		expect(output).toContain("### Tool calls")
		expect(output).toContain("run_sql")
		expect(output).toContain("table orders does not exist")
		expect(output).toContain("inspect_span")
	})

	it("says so when the span is not in the trace", async () => {
		const output = await rendered("inspect_agent_session_span", {
			session_id: SESSION_ID,
			trace_id: TRACE_ID,
			span_id: "9999999999999999",
			...WINDOW,
		})
		expect(output).toContain("is not in trace")
	})
})

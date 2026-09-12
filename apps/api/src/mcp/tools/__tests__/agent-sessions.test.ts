// SAFETY-FILE: the fixtures below are warehouse rows this test authors itself.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"
import { WarehouseDriverError, WarehouseResponseLimitError } from "@maple/query-engine/execution"
import type { McpToolRequirements } from "@/mcp/tools/runtime-requirements"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "@/mcp/tools/types"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import { clipPayload } from "@/mcp/lib/agent-sessions"
import { registerGetAgentSessionTool } from "@/mcp/tools/get-agent-session"
import { registerGetAgentSessionTranscriptTool } from "@/mcp/tools/get-agent-session-transcript"
import { registerListAgentSessionSpansTool } from "@/mcp/tools/list-agent-session-spans"
import { registerInspectAgentSessionSpanTool } from "@/mcp/tools/inspect-agent-session-span"
import { __testables } from "@/services/warehouse/WarehouseQueryService"
import { restoreWarehouse, type FixtureRule } from "@/mcp/__evals__/fake-warehouse"
import { makeEvalRuntime, runToolDirect, type EvalRuntime } from "@/mcp/__evals__/eval-runtime"

const SESSION_ID = "wrun_01KZTEST"
const EMPTY_SESSION_ID = "wrun_01KZEMPTY"
/** A session whose first page fills the read — the truncation path. */
const BIG_SESSION_ID = "wrun_01KZBIG"
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
/** A trace whose spans fill a trace-pinned read: the page is its beginning. */
const PARTIAL_TRACE_ID = "0123456789abcdef0123456789abcdef"
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
				handler: (
					params: ToolInput,
				) => Effect.Effect<McpToolResult, McpToolError, McpToolRequirements>
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

// SAFETY: the validation paths below return before any service is read, so the
// handler's declared requirements are never touched.
const run = (effect: Effect.Effect<McpToolResult, McpToolError, McpToolRequirements>) =>
	Effect.runPromise(effect as Effect.Effect<McpToolResult, McpToolError, never>)

/** The markdown the tool rendered — NOT the `__maple_ui` payload beside it,
 *  which would let an assertion pass on the structured mirror alone. */
const markdown = (result: McpToolResult) => result.content[0].text

const properties = (name: string) =>
	toInputSchema(mapleToolCatalog.find((entry) => entry.name === name)!.schema).properties as Record<
		string,
		Record<string, unknown>
	>

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

	// The values a model may send are the schema's job, not a branch in the
	// handler: published as enums they are visible before the call.
	it("publishes the closed parameter sets as enums and the turn range as a pattern", () => {
		const list = properties("list_agent_sessions")
		expect(list.sort_by?.enum).toContain("durationMs")
		expect(list.sort_dir?.enum).toEqual(["asc", "desc"])
		expect(properties("list_agent_session_spans").scope?.enum).toEqual(["all", "ai", "app"])
		expect(properties("get_agent_session_transcript").turns?.pattern).toBe("^\\d+(-\\d*)?$")
	})
})

describe("agent session parameter validation", () => {
	it("rejects a lone window bound — the pair is what makes the read a seek", async () => {
		const tool = captureTool(registerGetAgentSessionTool)
		const result = await run(tool.handler({ session_id: SESSION_ID, start_time: "2026-08-19 09:00:00" }))
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("start_time and end_time are a pair")
	})

	it("rejects a blank required id instead of throwing on the request class", async () => {
		const tool = captureTool(registerGetAgentSessionTool)
		const result = await run(tool.handler({ session_id: "  " }))
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("session_id is required")
	})

	it("rejects the turn ranges that parse but cannot select anything", async () => {
		const tool = captureTool(registerGetAgentSessionTranscriptTool)
		for (const turns of ["0", "9-4"]) {
			const result = await run(tool.handler({ session_id: SESSION_ID, turns }))
			expect(result.isError, turns).toBe(true)
			expect(markdown(result), turns).toContain("Invalid turns")
		}
	})

	it("rejects half a keyset cursor", async () => {
		const tool = captureTool(registerListAgentSessionSpansTool)
		const result = await run(tool.handler({ session_id: SESSION_ID, after_span_id: "1111111111111111" }))
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("after_timestamp and after_span_id are a pair")
	})

	it("rejects a trace id that is not 32 hex characters", async () => {
		const tool = captureTool(registerInspectAgentSessionSpanTool)
		const result = await run(
			tool.handler({ session_id: SESSION_ID, trace_id: "7f3a4b5c", span_id: "1111111111111111" }),
		)
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid trace_id")
	})
})

describe("clipPayload", () => {
	it("clips to the character budget and reports the true size in bytes", () => {
		expect(clipPayload(`${"a".repeat(20)}é`, 5)).toBe("aaaaa… (22 bytes total)")
		expect(clipPayload("short", 5)).toBe("short")
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

/** The session's own row, in the wire shape `aiSessionTotalsRowSchema` decodes —
 *  the exact totals a truncated session is reported with. */
const totalsRow = {
	traceCount: "3",
	startTime: "2026-08-19 10:00:00.000000000",
	endTime: "2026-08-19 11:30:00.000000000",
	durationMs: "5400000",
	spanCount: "9001",
	aiSpanCount: "9000",
	llmCalls: "4500",
	toolCalls: "4000",
	errorSpanCount: "7",
	inputTokens: "0",
	outputTokens: "0",
	cacheReadTokens: "0",
	llmInputTokens: "0",
	llmOutputTokens: "0",
	llmCacheReadTokens: "0",
	costReporters: "0",
	cost: "0",
	llmCost: "0",
	models: ["gpt-5"],
	agentNames: ["maple"],
}

/** One `trace_detail_spans` row, in the wire shape `aiSessionSpansRowSchema` decodes. */
const spanRow = (
	spanId: string,
	parentSpanId: string,
	spanName: string,
	timestamp: string,
	durationMs: number,
	statusCode: string,
	spanAttributes: Record<string, string>,
	sessionId: string = SESSION_ID,
) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId,
	spanName,
	spanKind: "Internal",
	serviceName: "agent-runner",
	durationMs,
	statusCode,
	statusMessage: statusCode === "Error" ? "tool call failed" : "",
	timestamp,
	spanAttributes: {
		"maple_ai.session.id": sessionId,
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

/** A page that exactly fills the read plus the row that proves a page follows:
 *  one turn, so the derivations stay about paging rather than about turns. */
const bigSpanId = (index: number) => `b${index.toString(16).padStart(15, "0")}`
const bigSessionSpanRows = [
	spanRow(
		bigSpanId(0),
		"",
		"invoke_agent maple",
		"2026-08-19 10:00:00.000000000",
		2_000_000,
		"Unset",
		{ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "maple" },
		BIG_SESSION_ID,
	),
	...Array.from({ length: AI_SESSION_SPANS_MAX_SPANS }, (_, index) =>
		spanRow(
			bigSpanId(index + 1),
			bigSpanId(0),
			"chat gpt-5",
			`2026-08-19 10:${String(Math.floor((index + 1) / 60)).padStart(2, "0")}:${String((index + 1) % 60).padStart(2, "0")}.000000000`,
			10,
			"Unset",
			{ "gen_ai.operation.name": "chat", "gen_ai.response.model": "gpt-5" },
			BIG_SESSION_ID,
		),
	),
]
/** The cursor the first page ends on — the second page's SQL names it. */
const BIG_PAGE_CURSOR_SPAN_ID = bigSpanId(AI_SESSION_SPANS_MAX_SPANS - 1)

/** One row past the trace-pinned read's limit: the extra row is what makes the
 *  page report a cursor, and the cursor is what makes the read partial. */
const partialTraceSpanRows = Array.from({ length: AI_SESSION_SPANS_MAX_SPANS + 1 }, (_, index) => ({
	...spanRow(
		bigSpanId(index),
		index === 0 ? "" : bigSpanId(0),
		"chat gpt-5",
		`2026-08-19 10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000000000`,
		10,
		"Unset",
		{ "gen_ai.operation.name": "chat", "gen_ai.response.model": "gpt-5" },
	),
	traceId: PARTIAL_TRACE_ID,
}))

// First match wins: the reads over `trace_detail_spans` are told apart by the
// derived tables and aggregates their SQL names.
const fixtures: FixtureRule[] = [
	{ match: (sql) => sql.includes(EMPTY_SESSION_ID), rows: [] },
	{ match: (sql) => sql.includes("facet_traces"), rows: facetRows },
	{ match: (sql) => sql.includes("measured_sessions"), rows: distributionRows },
	// The summary's two reads: the turn rows under `GROUP BY`, the session's own
	// row without it. Only a truncated session asks for them.
	{ match: (sql) => sql.includes("GROUP BY turnKey"), rows: [] },
	{ match: (sql) => sql.includes("aiSpanCount") && sql.includes("trace_detail_spans"), rows: [totalsRow] },
	{ match: (sql) => sql.includes(PARTIAL_TRACE_ID), rows: partialTraceSpanRows },
	{ match: (sql) => sql.includes(BIG_SESSION_ID), rows: bigSessionSpanRows },
	{ match: (sql) => sql.includes("trace_detail_spans"), rows: sessionSpanRows },
	{
		match: (sql) => /\bfrom\s+traces\b/i.test(sql),
		rows: [
			{
				// Sub-second, as a session's own bounds are: the next-step hint has
				// to round the end UP or the last spans fall outside it.
				startTime: "2026-08-19 10:00:00.000000000",
				endTime: "2026-08-19 10:00:05.250000000",
				spanCount: 4,
			},
		],
	},
	{ match: (sql) => sql.includes("ai_trace_index"), rows: [listRow] },
]

/**
 * SQL the warehouse answers with a response-limit abort rather than rows.
 *
 * The fake warehouse answers from fixtures, and a 413 is a driver failure and
 * not a row set; the client is also cached for the runtime's lifetime, so the
 * failure has to be switchable from inside one installed client.
 */
let responseTooLargeFor: (sql: string) => boolean = () => false

const installFixtureWarehouse = (rules: FixtureRule[]): void => {
	__testables.setClientFactory(() =>
		Effect.succeed({
			sql: (statement) =>
				Effect.suspend(
					(): Effect.Effect<
						{ data: ReadonlyArray<Record<string, unknown>> },
						WarehouseDriverError | WarehouseResponseLimitError
					> => {
						const sql = statement.text
						if (responseTooLargeFor(sql)) {
							return Effect.fail(
								new WarehouseResponseLimitError({
									kind: "bytes",
									message: "response exceeded the byte limit",
								}),
							)
						}
						const rule = rules.find((candidate) => candidate.match(sql))
						if (!rule) {
							return Effect.fail(
								new WarehouseDriverError({
									reason: "unknown",
									message: `[agent-sessions test] no fixture matched SQL:\n${sql.slice(0, 600)}`,
								}),
							)
						}
						return Effect.succeed({ data: rule.rows as ReadonlyArray<Record<string, unknown>> })
					},
				),
			insert: () => Effect.void,
		}),
	)
}

let rt: EvalRuntime

beforeAll(() => {
	installFixtureWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterEach(() => {
	responseTooLargeFor = () => false
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const rendered = async (name: string, params: Record<string, unknown>): Promise<string> =>
	markdown((await runToolDirect(rt, name, params)) as McpToolResult)

const renderedResult = async (name: string, params: Record<string, unknown>): Promise<McpToolResult> =>
	(await runToolDirect(rt, name, params)) as McpToolResult

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

	// A bare `offset=` would page a DIFFERENT list: the default 24h window, 25
	// rows at a time.
	it("carries the window and the page size into the next-page hint", async () => {
		const output = await rendered("list_agent_sessions", { ...WINDOW, limit: 1 })
		expect(output).toContain(
			`list_agent_sessions start_time="${WINDOW.start_time}" end_time="${WINDOW.end_time}" limit=1 offset=1`,
		)
		expect(output).toContain("re-pass the same filters")
	})

	// An LLM sends `""` for "no filter" and a fractional count for a whole one;
	// the request class refuses both by throwing.
	it("normalizes the filters a model sends loosely", async () => {
		const output = await rendered("list_agent_sessions", {
			...WINDOW,
			tools: "run_sql, search_logs",
			search: "",
			tokens_min: 1.5,
			cost_min: -5,
			sort_by: "cost",
			sort_dir: "asc",
		})
		expect(output).toContain(SESSION_ID)
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

	// No window: the session's bounds are resolved from the id, and the hint
	// hands them on with the fractional end rounded up.
	it("resolves the session's own bounds when no window is given", async () => {
		const output = await rendered("get_agent_session", { session_id: SESSION_ID })
		expect(output).toContain("Window: 2026-08-19 10:00:00.000000000 — 2026-08-19 10:00:05.250000000")
		expect(output).toContain('start_time="2026-08-19 10:00:00" end_time="2026-08-19 10:00:06"')
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

	it("renders an open turn range from its first turn on", async () => {
		const output = await rendered("get_agent_session_transcript", {
			session_id: SESSION_ID,
			...WINDOW,
			turns: "1-",
		})
		expect(output).toContain("why is checkout failing?")
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

	it("reads a page from a keyset cursor and a scope", async () => {
		const output = await rendered("list_agent_session_spans", {
			session_id: SESSION_ID,
			...WINDOW,
			scope: "ai",
			after_timestamp: "2026-08-19 10:00:00.000000000",
			after_span_id: "1111111111111111",
		})
		expect(output).toContain("scope ai")
		expect(output).toContain("2222222222222222")
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
		// Both follow-ups scan a window around now unless given the span's own
		// timestamp, so a session older than that would answer empty without it.
		expect(output).toContain('inspect_span trace_id="7f3a4b5c6d7e8f901234567890abcdef"')
		expect(output).toContain('timestamp="2026-08-19T10:00:00.500Z"')
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

	// A trace bigger than the read is the one case where "not in trace" would be
	// a lie: only its beginning was read, and the span may be past the cursor.
	it("says the trace was only partly read rather than that the span is absent", async () => {
		const output = await rendered("inspect_agent_session_span", {
			session_id: SESSION_ID,
			trace_id: PARTIAL_TRACE_ID,
			span_id: "9999999999999999",
			...WINDOW,
		})
		expect(output).toContain(`Only the first ${AI_SESSION_SPANS_MAX_SPANS} spans of trace`)
		expect(output).not.toContain("is not in trace")
		expect(output).toContain("list_agent_session_spans")
	})
})

describe("a session too large to load whole", () => {
	it("answers a first-page 413 with the tool's own way out", async () => {
		responseTooLargeFor = (sql) => sql.includes(BIG_SESSION_ID)

		const session = await renderedResult("get_agent_session", { session_id: BIG_SESSION_ID, ...WINDOW })
		expect(session.isError).toBe(true)
		expect(markdown(session)).toContain("list_agent_session_spans")

		const spans = await renderedResult("list_agent_session_spans", {
			session_id: BIG_SESSION_ID,
			...WINDOW,
		})
		expect(spans.isError).toBe(true)
		expect(markdown(spans)).toContain("smaller `limit`")
	})

	// A 413 on a page after the first is what `truncated` describes: the pages
	// in hand are the session's beginning, and the warehouse answers the rest.
	it("keeps the pages in hand, the exact totals and the TRUE window", async () => {
		responseTooLargeFor = (sql) => sql.includes(BIG_PAGE_CURSOR_SPAN_ID)

		const output = await rendered("get_agent_session", { session_id: BIG_SESSION_ID, ...WINDOW })
		expect(output).toContain("spans were loaded")
		expect(output).toContain("Warehouse totals for the WHOLE session: 9001 spans")
		// The window the read ran under, not the loaded spans' extent — which
		// ends an hour and a half before the session does.
		expect(output).toContain('start_time="2026-08-19 09:00:00" end_time="2026-08-19 12:00:00"')
	})

	it("closes a truncated transcript with the divider that says so", async () => {
		responseTooLargeFor = (sql) => sql.includes(BIG_PAGE_CURSOR_SPAN_ID)

		const output = await rendered("get_agent_session_transcript", {
			session_id: BIG_SESSION_ID,
			...WINDOW,
		})
		expect(output).toContain("The END of this session was not loaded")
		expect(output).toContain("more of this session was not loaded")
	})
})

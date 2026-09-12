// SAFETY-FILE: the fixtures below are warehouse rows this test authors itself.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"
import { WarehouseDriverError, WarehouseResponseLimitError } from "@maple/query-engine/execution"
import type { McpToolRequirements } from "@/mcp/tools/runtime-requirements"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "@/mcp/tools/types"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import { clipPayload, loadAgentSessionSpans, MCP_AGENT_SESSION_MAX_SPANS } from "@/mcp/lib/agent-sessions"
import { buildSessionFindings, buildSessionSummary, buildSessionTurns } from "@maple/agent-sessions"
import { registerGetAgentSessionTool } from "@/mcp/tools/get-agent-session"
import { registerListAgentSessionSpansTool } from "@/mcp/tools/list-agent-session-spans"
import { __testables } from "@/services/warehouse/WarehouseQueryService"
import { restoreWarehouse, type FixtureRule } from "@/mcp/__evals__/fake-warehouse"
import { makeEvalRuntime, runToolDirect, type EvalRuntime } from "@/mcp/__evals__/eval-runtime"

const SESSION_ID = "wrun_01KZTEST"
const EMPTY_SESSION_ID = "wrun_01KZEMPTY"
/** A session whose first page fills the read — the truncation path. */
const BIG_SESSION_ID = "wrun_01KZBIG"
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
	["get_agent_session", ["session_id"]],
	["list_agent_session_spans", ["session_id"]],
]

describe("agent session tool registration", () => {
	it("registers all three with object input schemas and the expected required params", () => {
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
	it("publishes the closed parameter sets as enums", () => {
		const list = properties("list_agent_sessions")
		expect(list.sort_by?.enum).toContain("durationMs")
		expect(list.sort_dir?.enum).toEqual(["asc", "desc"])
		expect(properties("list_agent_session_spans").scope?.enum).toEqual(["all", "ai", "app"])
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

	it("rejects half a keyset cursor", async () => {
		const tool = captureTool(registerListAgentSessionSpansTool)
		const result = await run(tool.handler({ session_id: SESSION_ID, after_span_id: "1111111111111111" }))
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("after_timestamp and after_span_id are a pair")
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

/* -------------------------------------------------------------------------- */
/* A session at the whole-session cap, with the payloads a real one carries    */
/* -------------------------------------------------------------------------- */

const HUGE_SESSION_ID = "wrun_01KZHUGE"
const HUGE_PAGE_SIZE = AI_SESSION_SPANS_MAX_SPANS
/** Pages the cap is worth — the loader stops at exactly this many. */
const HUGE_PAGES = MCP_AGENT_SESSION_MAX_SPANS / HUGE_PAGE_SIZE
/** Per captured payload, which is the size an agent turn's re-sent history is. */
const HUGE_PAYLOAD_CHARS = 10_000

const hugeSpanId = (index: number) => `h${index.toString(16).padStart(15, "0")}`
const padded = (head: string) => `${head}\n${"x".repeat(HUGE_PAYLOAD_CHARS)}`

/** Every span carries a whole conversation, and every fourth one failed with a
 *  payload-sized result — the two things the clip has to keep readable. */
const hugeSpanRow = (index: number) =>
	spanRow(
		hugeSpanId(index),
		index === 0 ? "" : hugeSpanId(0),
		index === 0 ? "invoke_agent maple" : "chat gpt-5",
		`2026-08-19 10:00:00.${String(index).padStart(9, "0")}`,
		10,
		"Unset",
		index === 0
			? { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "maple" }
			: {
					"gen_ai.operation.name": index % 4 === 0 ? "execute_tool" : "chat",
					"gen_ai.response.model": "gpt-5",
					// The history ends on a tool result carried by a role-`user` entry
					// (the Anthropic shape): the label is the user message BEFORE it,
					// which the clip has to keep.
					"gen_ai.input.messages": JSON.stringify([
						{ role: "assistant", parts: [{ type: "text", content: padded("earlier reply") }] },
						{
							role: "user",
							parts: [{ type: "text", content: padded("why is checkout failing?") }],
						},
						{ role: "assistant", parts: [{ type: "tool_call", id: "call_0", name: "run_sql" }] },
						{
							role: "user",
							parts: [
								{ type: "tool_call_response", id: "call_0", response: padded("42 rows") },
							],
						},
					]),
					"gen_ai.output.messages": JSON.stringify([
						{ role: "assistant", parts: [{ type: "text", content: "looking into it" }] },
					]),
					...(index % 4 === 0 && {
						"gen_ai.tool.name": "run_sql",
						"gen_ai.tool.call.id": `call_${index}`,
						"gen_ai.tool.call.result": JSON.stringify({
							error: padded("table orders does not exist"),
						}),
						"error.type": "tool_error",
					}),
				},
		HUGE_SESSION_ID,
	)

/** One page as the warehouse would answer it: a row past the page for every
 *  page but the last, which is what makes the read report a cursor. */
const hugePage = (page: number) => {
	const from = page * HUGE_PAGE_SIZE
	const to = Math.min(from + HUGE_PAGE_SIZE + 1, HUGE_PAGE_SIZE * HUGE_PAGES)
	return Array.from({ length: to - from }, (_, index) => hugeSpanRow(from + index))
}

/** The cursor a page ends on — the next page's SQL names it. */
const hugeCursorSpanId = (page: number) => hugeSpanId((page + 1) * HUGE_PAGE_SIZE - 1)

// First match wins: the reads over `trace_detail_spans` are told apart by the
// derived tables and aggregates their SQL names.
const fixtures: FixtureRule[] = [
	// Pages are built on access, so only the page being read is ever raw —
	// which is the property the retained-size assertion is about.
	...Array.from({ length: HUGE_PAGES - 1 }, (_, page) => ({
		match: (sql: string) => sql.includes(hugeCursorSpanId(page)),
		get rows() {
			return hugePage(page + 1)
		},
	})),
	{
		match: (sql: string) => sql.includes(HUGE_SESSION_ID) && sql.includes("trace_detail_spans"),
		get rows() {
			return hugePage(0)
		},
	},
	{ match: (sql) => sql.includes(EMPTY_SESSION_ID), rows: [] },
	// The summary's two reads: the turn rows under `GROUP BY`, the session's own
	// row without it. Only a truncated session asks for them.
	{ match: (sql) => sql.includes("GROUP BY turnKey"), rows: [] },
	{ match: (sql) => sql.includes("aiSpanCount") && sql.includes("trace_detail_spans"), rows: [totalsRow] },
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

describe("get_agent_session rendering", () => {
	it("renders the verdict, findings, tokens and tools of a failed session", async () => {
		const output = await rendered("get_agent_session", { session_id: SESSION_ID, ...WINDOW })
		expect(output).toContain("### Verdict")
		expect(output).toContain("tool_error")
		expect(output).toContain("### Tokens")
		expect(output).toContain("### Tools")
		expect(output).toContain("run_sql")
		expect(output).toContain("2 LLM calls")
		expect(output).toContain("inspect_span")
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

describe("list_agent_session_spans rendering", () => {
	it("lists the page with its ids and marks the failed span", async () => {
		const output = await rendered("list_agent_session_spans", { session_id: SESSION_ID, ...WINDOW })
		expect(output).toContain("3333333333333333")
		expect(output).toContain("FAILED")
		expect(output).toContain("inference")
		expect(output).toContain("inspect_span")
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
})

// A long agent session is tens of thousands of spans, each re-sending the whole
// conversation: the load is affordable only because the content is clipped as
// each page is mapped, and what the derivations read has to survive that.
describe("a session loaded to the whole-session cap", () => {
	it("loads 10 000 spans without retaining their payloads, and still labels turns and findings", async () => {
		const loaded = await rt.runtime.runPromise(
			loadAgentSessionSpans(rt.tenant, {
				sessionId: HUGE_SESSION_ID,
				window: undefined,
				scope: "all",
			}),
		)

		expect(loaded.spans.length).toBe(MCP_AGENT_SESSION_MAX_SPANS)
		// The session ENDS at the cap: nothing is missing, so nothing is claimed.
		expect(loaded.truncated).toBe(false)
		// ~2 KB of retained content per span against the ~20 KB each carried.
		expect(JSON.stringify(loaded.spans).length).toBeLessThan(40_000_000)

		const turns = buildSessionTurns(loaded.spans)
		const summary = buildSessionSummary({ spans: loaded.spans, turns })
		const report = buildSessionFindings(turns, summary)
		// The turn label is the newest user message, which is the message the
		// clip keeps; the finding's detail is the failed call's own result.
		expect(turns.some((turn) => turn.label === "why is checkout failing?")).toBe(true)
		// The detail is the result's prose line itself — not the JSON wrapper a
		// serialised payload would put in front of it.
		const detail = report.findings.find((finding) => finding.detail?.includes("table orders"))?.detail
		expect(detail?.startsWith("table orders does not exist")).toBe(true)
	}, 120_000)
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"
import { mapleToolCatalog, toInputSchema } from "../registry"
import { clipPayload, MCP_AGENT_SESSION_MAX_SPANS } from "../../lib/agent-sessions"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { aiSpanRow } from "../../__evals__/fixtures"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import type { McpToolResult } from "../types"

const SESSION_ID = "wrun_01KZTEST"
const EMPTY_SESSION_ID = "wrun_01KZEMPTY"
/** A session with a page after its first — the truncation path. */
const BIG_SESSION_ID = "wrun_01KZBIG"
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
/** Only reachable through a CSV filter that reached the SQL as trimmed entries. */
const CSV_SESSION_ID = "wrun_01KZCSV"
const WINDOW = { start_time: "2026-08-19 09:00:00", end_time: "2026-08-19 12:00:00" }

// Registration

const AGENT_SESSION_TOOLS: ReadonlyArray<{
	readonly name: string
	readonly required: ReadonlyArray<string>
	readonly enums: Readonly<Record<string, ReadonlyArray<string>>>
}> = [
	{
		name: "list_agent_sessions",
		required: [],
		// The values a model may send are the schema's job, not a branch in the
		// handler: published as enums they are visible before the call.
		enums: { sort_dir: ["asc", "desc"] },
	},
	{ name: "get_agent_session", required: ["session_id"], enums: {} },
]

describe("agent session tool registration", () => {
	it("registers both with their required params, framing and published enums", () => {
		for (const tool of AGENT_SESSION_TOOLS) {
			const definition = mapleToolCatalog.find((entry) => entry.name === tool.name)
			expect(definition, tool.name).toBeDefined()
			const schema = toInputSchema(definition!.schema)
			expect(schema.type, tool.name).toBe("object")
			expect(schema.required ?? [], tool.name).toEqual(tool.required)
			expect(definition!.description, tool.name).toMatch(/AI agent session/i)
			const properties = schema.properties as Record<string, Record<string, unknown>>
			for (const [param, values] of Object.entries(tool.enums)) {
				expect(properties[param]?.enum, `${tool.name}.${param}`).toEqual(values)
			}
		}
	})
})

// Warehouse rows, in their wire shapes

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
	agentEnd: "2026-08-19 10:00:05.250000000",
	agentDurationMs: 5_000,
}

const sessionSpan = (
	spanId: string,
	spanName: string,
	timestamp: string,
	attributes: Record<string, string>,
	opts: { readonly statusCode?: string; readonly sessionId?: string } = {},
) =>
	aiSpanRow({
		spanId,
		spanName,
		traceId: TRACE_ID,
		parentSpanId: spanId === "1111111111111111" ? "" : "1111111111111111",
		timestamp,
		durationMs: 900,
		statusCode: opts.statusCode,
		attributes: {
			"maple_ai.session.id": opts.sessionId ?? SESSION_ID,
			"maple_ai.vendor.id": "eve",
			...attributes,
		},
	})

/** One failed turn: an agent invocation, the call that asked for a tool, the
 *  tool span that failed, and the model's answer. */
const sessionSpanRows = [
	sessionSpan("1111111111111111", "invoke_agent maple", "2026-08-19 10:00:00.000000000", {
		"gen_ai.operation.name": "invoke_agent",
		"gen_ai.agent.name": "maple",
	}),
	sessionSpan("2222222222222222", "chat gpt-5", "2026-08-19 10:00:00.500000000", {
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
			{ role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "run_sql" }] },
		]),
	}),
	sessionSpan(
		"3333333333333333",
		"execute_tool run_sql",
		"2026-08-19 10:00:02.000000000",
		{
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "run_sql",
			"gen_ai.tool.call.id": "call_1",
			"gen_ai.tool.call.result": JSON.stringify({ error: "table orders does not exist" }),
			"error.type": "tool_error",
		},
		{ statusCode: "Error" },
	),
	sessionSpan("4444444444444444", "chat gpt-5", "2026-08-19 10:00:03.000000000", {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "gpt-5",
		"gen_ai.usage.input_tokens": "1400",
		"gen_ai.usage.output_tokens": "120",
	}),
]

/** A page that fills the read plus the row that proves a page follows — one
 *  turn, so the fixture stays about paging rather than about turns. */
const bigSpanId = (index: number) => `b${index.toString(16).padStart(15, "0")}`
const bigSessionSpanRows = [
	sessionSpan(
		bigSpanId(0),
		"invoke_agent maple",
		"2026-08-19 10:00:00.000000000",
		{ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "maple" },
		{ sessionId: BIG_SESSION_ID },
	),
	...Array.from({ length: AI_SESSION_SPANS_MAX_SPANS }, (_, index) =>
		sessionSpan(
			bigSpanId(index + 1),
			"chat gpt-5",
			`2026-08-19 10:${String(Math.floor((index + 1) / 60)).padStart(2, "0")}:${String(
				(index + 1) % 60,
			).padStart(2, "0")}.000000000`,
			{ "gen_ai.operation.name": "chat", "gen_ai.response.model": "gpt-5" },
			{ sessionId: BIG_SESSION_ID },
		),
	),
]
/** The cursor the first page ends on — the second page's SQL names it. */
const BIG_PAGE_CURSOR_SPAN_ID = bigSpanId(AI_SESSION_SPANS_MAX_SPANS - 1)

// First match wins: the reads over `trace_detail_spans` are told apart by the
// session ids their SQL names.
const fixtures: FixtureRule[] = [
	{ match: (sql) => sql.includes(EMPTY_SESSION_ID), rows: [] },
	{ match: (sql) => sql.includes(BIG_SESSION_ID), rows: bigSessionSpanRows },
	{ match: (sql) => sql.includes("trace_detail_spans"), rows: sessionSpanRows },
	{
		match: (sql) => /\bfrom\s+traces\b/i.test(sql),
		rows: [
			{
				// Sub-second, as a session's own bounds are: the pad the next-step
				// hint applies is what keeps the last spans inside it.
				startTime: "2026-08-19 10:00:00.000000000",
				endTime: "2026-08-19 10:00:05.250000000",
				spanCount: 4,
			},
		],
	},
	// The CSV filter, as the SQL names its entries: trimmed and one per value.
	{
		match: (sql) => sql.includes("'run_sql'") && sql.includes("'search_logs'"),
		rows: [{ ...listRow, sessionId: CSV_SESSION_ID }],
	},
	{ match: (sql) => sql.includes("ai_trace_index"), rows: [listRow] },
]

/** SQL the warehouse aborts on rather than answering with rows — a 413 is a
 *  driver failure, not a row set. */
let responseTooLargeFor: (sql: string) => boolean = () => false

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(fixtures, (sql) => responseTooLargeFor(sql))
	rt = makeEvalRuntime()
})

afterEach(() => {
	responseTooLargeFor = () => false
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const result = async (name: string, params: Record<string, unknown>): Promise<McpToolResult> =>
	(await runToolDirect(rt, name, params)) as McpToolResult

const rendered = async (name: string, params: Record<string, unknown>): Promise<string> =>
	markdown(await result(name, params))

/** The cells of the rendered table row that opens with `first`. */
const rowCells = (text: string, first: string): ReadonlyArray<string> | undefined =>
	text
		.split("\n")
		.filter((line) => line.startsWith("| "))
		.map((line) =>
			line
				.slice(1, -1)
				.split(" | ")
				.map((cell) => cell.trim()),
		)
		.find((cells) => cells[0] === first)

// Parameters

describe("agent session parameter validation", () => {
	it("rejects a lone window bound — the pair is what makes the read a seek", async () => {
		const answer = await result("get_agent_session", {
			session_id: SESSION_ID,
			start_time: "2026-08-19 09:00:00",
		})
		expect(answer.isError).toBe(true)
		expect(markdown(answer)).toContain("start_time and end_time are a pair")
	})

	it("rejects a blank session id as a parameter error", async () => {
		expect(markdown(await result("get_agent_session", { session_id: "" }))).toContain(
			"Invalid parameters",
		)
	})

	// The bounds reach a column comparison, so a negative or fractional one is a
	// malformed request rather than a silently clamped filter.
	it("rejects a negative range bound and a fractional count bound", async () => {
		expect(markdown(await result("list_agent_sessions", { cost_min: -5 }))).toContain(
			"Invalid parameters",
		)
		expect(markdown(await result("list_agent_sessions", { tokens_min: 1.5 }))).toContain(
			"Invalid parameters",
		)
	})

	// The bounds publish as number-or-numeric-string, like limit/offset — and the
	// bound applies to the string branch too.
	it("takes a bound as a numeric string, still bounded", async () => {
		const output = await rendered("list_agent_sessions", { ...WINDOW, tokens_min: "1000" })
		expect(rowCells(output, SESSION_ID)).toBeDefined()
		expect(markdown(await result("list_agent_sessions", { cost_min: "-5" }))).toContain(
			"Invalid parameters",
		)
	})
})

describe("clipPayload", () => {
	it("clips to the character budget and reports the true size in bytes", () => {
		expect(clipPayload(`${"a".repeat(20)}é`, 5)).toBe("aaaaa… (22 bytes total)")
		expect(clipPayload("short", 5)).toBe("short")
	})
})

// Rendering

describe("list_agent_sessions rendering", () => {
	it("renders the row and hands the session's own window to the next step", async () => {
		const output = await rendered("list_agent_sessions", { ...WINDOW })
		const cells = rowCells(output, SESSION_ID)
		expect(cells?.[1]).toBe("maple")
		expect(cells?.[2]).toBe("eve")
		// Errors are agent/tool/turn, in that order.
		expect(cells?.[7]).toBe("1/1/0")
		// The hint is the row's bounds PADDED the way the page pads them: a row's
		// bounds are its agent spans' extent, and both read levels bound on
		// `Timestamp`, so handing them over verbatim would drop the app spans
		// around them — and the sub-second end with them.
		expect(output).toContain(
			`get_agent_session session_id="${SESSION_ID}" start_time="2026-08-19 08:59:00" end_time="2026-08-19 11:01:05"`,
		)
	})

	it("says how to continue when the page is full", async () => {
		const full = await rendered("list_agent_sessions", { ...WINDOW, limit: 1, offset: 4 })
		expect(full).toContain("call again with offset=5")
		const partial = await rendered("list_agent_sessions", { ...WINDOW, limit: 2 })
		expect(partial).not.toContain("call again with offset=")
	})

	it("parses a comma-separated filter into the entries the SQL matches on", async () => {
		const output = await rendered("list_agent_sessions", { ...WINDOW, tools: "run_sql, search_logs" })
		expect(rowCells(output, CSV_SESSION_ID)).toBeDefined()
	})
})

describe("get_agent_session rendering", () => {
	it("renders the verdict, findings, tokens and tools of a failed session", async () => {
		const answer = await result("get_agent_session", { session_id: SESSION_ID, ...WINDOW })
		// Text only: neither session tool writes a `__maple_ui` mirror block.
		expect(answer.content).toHaveLength(1)
		const output = markdown(answer)
		expect(output).toContain("### Verdict")
		// The checks are the reading: a heading with the counts even when nothing
		// needs attention, the failed tool as a row with what to do, and the
		// checks that passed as bullets with the fact each measured.
		expect(output).toMatch(/### Checks \(\d+ failed · \d+ warnings? · \d+ passed · \d+ not checked\)/)
		expect(output).toMatch(
			/^\| (failed|warning) \| Tool errors \| .+ \| Fix the tool, or make its error text say what to do next\. \|$/m,
		)
		expect(output).toMatch(/^- Rate limits \(passed\): No model call was rate-limited$/m)
		expect(output).toContain("tool_error")
		expect(output).toContain("### Tokens")
		expect(rowCells(output, "run_sql")?.[2]).toBe("1")
		expect(output).toContain("2 LLM calls")
		expect(output).toContain(`inspect_span trace_id="${TRACE_ID}"`)
	})

	// No window: the session's bounds are resolved from the id.
	it("resolves the session's own bounds when no window is given", async () => {
		const output = await rendered("get_agent_session", { session_id: SESSION_ID })
		expect(output).toContain("Window: 2026-08-19 10:00:00.000000000 — 2026-08-19 10:00:05.250000000")
	})

	it("answers an unknown session without inventing one", async () => {
		const output = await rendered("get_agent_session", { session_id: EMPTY_SESSION_ID, ...WINDOW })
		expect(output).toContain("No spans for AI agent session")
	})

	// A 413 on a page after the first is what the cap describes: the pages in
	// hand are the session's beginning, and the answer says so.
	it("keeps the pages in hand when a later page cannot be read", async () => {
		responseTooLargeFor = (sql) => sql.includes(BIG_PAGE_CURSOR_SPAN_ID)
		const output = await rendered("get_agent_session", { session_id: BIG_SESSION_ID, ...WINDOW })
		expect(output).toContain(
			`Loaded the first ${AI_SESSION_SPANS_MAX_SPANS.toLocaleString("en-US")} spans; the rest exceeded the response byte limit.`,
		)
		// The way out names an absolute bound: the last span in hand, so the next
		// call has something to narrow from.
		const lastLoaded = bigSessionSpanRows[AI_SESSION_SPANS_MAX_SPANS - 1]
		expect(output).toContain(
			`Pass start_time="${lastLoaded.timestamp.slice(0, 19)}" with the same end_time`,
		)
	})

	// Every page ends on a cursor, so the read stops on the span cap rather than
	// on the session — a different sentence, and a different way out.
	it("says so when the span cap, not the session, ended the read", async () => {
		const output = await rendered("get_agent_session", { session_id: BIG_SESSION_ID, ...WINDOW })
		expect(output).toContain(
			`Loaded the first ${MCP_AGENT_SESSION_MAX_SPANS.toLocaleString("en-US")} spans of this session (the cap)`,
		)
		expect(output).toContain("covers those spans only")
	})

	// The byte cap trips on ROW WEIGHT, and the sessions this tool exists for are
	// exactly the heavy ones — the same page at half the rows is the read the 413
	// asks for, and the session still loads whole.
	it("halves the page and retries when the first page is too large", async () => {
		responseTooLargeFor = (sql) => sql.includes(`LIMIT ${AI_SESSION_SPANS_MAX_SPANS + 1}`)
		const output = await rendered("get_agent_session", { session_id: SESSION_ID, ...WINDOW })
		expect(output).toContain("### Verdict")
		expect(rowCells(output, "run_sql")?.[2]).toBe("1")
		expect(output).not.toContain("exceeded the response byte limit")
	})

	it("answers a first-page 413 with a way out", async () => {
		responseTooLargeFor = (sql) => sql.includes(BIG_SESSION_ID)
		const answer = await result("get_agent_session", { session_id: BIG_SESSION_ID, ...WINDOW })
		expect(answer.isError).toBe(true)
		expect(markdown(answer)).toContain("start_time/end_time")
	})
})

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { mapleToolCatalog, toInputSchema } from "../registry"
import type { McpToolResult } from "../types"
import { Schema } from "effect"
import { GetAgentToolErrorOutput, GetAgentToolsOverviewOutput } from "@maple/domain/mcp-outputs"
import { TREND_BUCKETS } from "../../lib/agent-tool-analytics"
import { AI_TOOL_ERROR_PAYLOAD_MAX } from "@maple/query-engine-integrations/ai"

// Both tools run through the registry the way a client reaches them:
// `runToolDirect` decodes the parameters against the published schema and
// dispatches by name, so a tool dropped from `registry.ts` fails here.

const OVERVIEW = "get_agent_tools_overview"
const ERROR_DETAIL = "get_agent_tool_error"

type ToolParams = Record<string, string | number | boolean>

const definitionOf = (name: string) => {
	const definition = mapleToolCatalog.find((candidate) => candidate.name === name)
	if (definition === undefined) throw new Error(`${name} is not in the MCP tool registry`)
	return definition
}

/** A table line's cells, without the leading and trailing pipe. */
const lineCells = (line: string): ReadonlyArray<string> => line.slice(2, -2).split(" | ")

/** The cells of the table row starting with `first` — asserting cell by cell
 *  keeps a new column from breaking every table test. */
const rowCells = (rendered: string, first: string): ReadonlyArray<string> => {
	const line = rendered.split("\n").find((candidate) => candidate.startsWith(`| ${first} |`))
	if (line === undefined) throw new Error(`no table row starting with '${first}'`)
	return lineCells(line)
}

/** The clipped arguments payload of the first sample — one line in its fence. */
const clippedArguments = (rendered: string): string =>
	rendered.split("\n").find((line) => line.startsWith(`{"query":"x`)) ?? ""

// A 12h window, whose trend bucket is the window over 23 — one short of the
// grid, so an unaligned window still fits it (see `compactTrend`).
const WINDOW = { start_time: "2026-09-12 00:00:00", end_time: "2026-09-12 12:00:00" }
const TREND_BUCKET_SECONDS = Math.ceil((12 * 60 * 60) / (TREND_BUCKETS - 1))

/** The window before it, which the totals read compares against: equal length,
 *  ending where this one begins. */
const PREVIOUS_START = "2026-09-11 12:00:00"

/** A window that does NOT start on a bucket boundary — every real 24h window
 *  a caller asks for at some time of day. */
const UNALIGNED_WINDOW = { start_time: "2026-09-12 12:30:00", end_time: "2026-09-13 12:30:00" }

/** The measure bag every totals and breakdown row carries. Percentiles are
 *  nanoseconds on the wire and milliseconds in the answer. */
const measures = (calls: number, sessions: number, errors: number, ms: [number, number, number]) => ({
	calls,
	sessions,
	errors,
	p50: ms[0] * 1_000_000,
	p90: ms[1] * 1_000_000,
	p95: ms[2] * 1_000_000,
})

const SEEN = "2026-09-12 08:00:00"
/** The bounds every row reports; only the group's trend is read by instant. */
const seen = { firstSeen: "2026-09-12 01:00:00", lastSeen: SEEN }
const unseen = { firstSeen: "", lastSeen: "" }

const totalsRows = [
	{ period: "current", ...measures(120, 12, 6, [12, 300, 900]), ...seen },
	{ period: "previous", ...measures(100, 10, 2, [10, 200, 600]), ...seen },
	{ period: "window", ...measures(0, 48, 0, [0, 0, 0]), ...unseen },
]

/** The shape an empty window really returns: an aggregate over no rows still
 *  yields one row per period, so `current` is zeroed rather than missing — and
 *  the `window` row still counts every agent session there was. */
const emptyTotalsRows = [
	{ period: "current", ...measures(0, 0, 0, [0, 0, 0]), ...unseen },
	{ period: "previous", ...measures(0, 0, 0, [0, 0, 0]), ...unseen },
	{ period: "window", ...measures(0, 48, 0, [0, 0, 0]), ...unseen },
]

const TOOL_DESCRIPTION = "Search the product documentation"

const breakdownRows = [
	{ key: "search_docs", ...measures(80, 9, 6, [12, 300, 900]), ...seen },
	{ key: "run_query", ...measures(40, 5, 0, [4, 20, 40]), ...seen },
]

const FINGERPRINT = "10453282193948324021"

const errorGroup = {
	fingerprint: FINGERPRINT,
	errorType: "TimeoutError",
	message: "upstream timed out after 30s",
	calls: 12,
	sessions: 4,
	variants: 2,
	...seen,
	callsSince: 15,
	// Only the buckets that had a failure — including the window's FIRST, which
	// the grid used to drop.
	trend: {
		"2026-09-12T00:00:00.000000Z": 3,
		"2026-09-12T06:00:00.000000Z": 4,
		[`${SEEN.replace(" ", "T")}.000000Z`]: 5,
	},
}

const sessionRows = [
	{
		sessionId: "sess_a",
		vendorId: "openai-agents",
		agentName: "researcher",
		service: "api",
		hits: 6,
		lastSeen: SEEN,
	},
]

const variantRows = [
	{ message: "upstream timed out after 30s", calls: 5, lastSeen: SEEN },
	{ message: "upstream timed out after 31s", calls: 4, lastSeen: "2026-09-12 07:00:00" },
]

const breakdownPairRows = [{ model: "claude-sonnet-4", service: "api", calls: 9 }]

// Exactly what the read returns for a payload it cut: `AI_TOOL_ERROR_PAYLOAD_MAX`
// characters, with the row reporting the true size the span carried.
const LONG_ARGUMENTS = `{"query":"${"x".repeat(AI_TOOL_ERROR_PAYLOAD_MAX - 12)}"}`
const LONG_ARGUMENTS_BYTES = 12_000

/** The payload rows below are joined to these by trace and span id. */
const occurrence = (ids: [string, string], sessionId: string, timestamp: string, durationNs: number) => ({
	timestamp,
	traceId: ids[0].repeat(32),
	spanId: ids[1].repeat(16),
	sessionId,
	vendorId: "openai-agents",
	agentName: "researcher",
	model: "claude-sonnet-4",
	service: "api",
	errorType: "TimeoutError",
	message: "upstream timed out after 30s",
	durationNs,
})

const occurrenceRows = [
	occurrence(["a", "b"], "sess_a", "2026-09-12 08:00:00.123456789", 30_000_000_000),
	occurrence(["c", "d"], "sess_b", "2026-09-12 07:00:00.000000000", 31_000_000_000),
]

/** `statusCode` is Title case on the wire, like every other Maple span status. */
const payload = (ids: [string, string], args: string, argumentsBytes: number) => ({
	traceId: ids[0].repeat(32),
	spanId: ids[1].repeat(16),
	statusCode: "Error",
	arguments: args,
	argumentsBytes,
	result: "TimeoutError: upstream timed out",
	resultBytes: 32,
})

const payloadRows = [
	payload(["a", "b"], LONG_ARGUMENTS, LONG_ARGUMENTS_BYTES),
	payload(["c", "d"], `{"query":"short"}`, 17),
]

/** The payload read, answering with rows of the test's own shape. */
const payloadsAre = (rows: ReadonlyArray<unknown>): FixtureRule[] => [
	{ match: (sql) => sql.includes("trace_detail_spans"), rows },
]

/** A result that is itself a fenced block: a fixed ``` fence around it is
 *  closed by the payload, and everything rendered after it reads as prose. */
const FENCED_RESULT = "TimeoutError in:\n```js\nawait search()\n```"

/** Every statement the fake answered, so a test can assert what it carried. */
const executedSql: string[] = []

/** The samples page's own statement: all four error-detail reads share the
 *  `failing_tool_calls` subquery, and only this one is ordered by the keyset. */
const samplesSql = (): ReadonlyArray<string> =>
	executedSql.filter(
		(sql) => sql.includes("failing_tool_calls") && sql.includes("ORDER BY timestamp DESC, spanId DESC"),
	)

const record = (match: (sql: string) => boolean) => (sql: string) => {
	if (!match(sql)) return false
	executedSql.push(sql)
	return true
}

// Order matters — first match wins. The four error-detail reads share the
// `failing_tool_calls` subquery (and every column alias in it), so they are told
// apart by the grouping of their OUTER select.
const fixtures: FixtureRule[] = [
	{ match: record((sql) => sql.includes("trace_detail_spans")), rows: payloadRows },
	// The only read that selects the tool's description.
	{
		match: record((sql) => sql.includes("ToolDescription")),
		rows: [{ description: TOOL_DESCRIPTION }],
	},
	{ match: record((sql) => sql.includes("tool_calls_current")), rows: totalsRows },
	{ match: record((sql) => sql.includes("tool_breakdown")), rows: breakdownRows },
	{ match: record((sql) => sql.includes("numbered_tool_calls")), rows: [errorGroup] },
	{ match: record((sql) => sql.includes("GROUP BY sessionId")), rows: sessionRows },
	{ match: record((sql) => sql.includes("GROUP BY message")), rows: variantRows },
	{ match: record((sql) => sql.includes("GROUP BY model, service")), rows: breakdownPairRows },
	// The samples page is the one failing-calls read that groups by nothing.
	{ match: record((sql) => sql.includes("failing_tool_calls")), rows: occurrenceRows },
]

/** Nothing anywhere, except the totals read, which answers one row per period. */
const EMPTY_RULES: FixtureRule[] = [
	{ match: (sql) => sql.includes("tool_calls_current"), rows: emptyTotalsRows },
	{ match: () => true, rows: [] },
]

// The warehouse client is built once with the layer, so the fake is installed
// once and the rules it consults are changed in place.
const live = [...fixtures]

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(live)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: ToolParams) => runToolDirect(rt, name, params) as Promise<McpToolResult>

const render = async (name: string, params: ToolParams): Promise<string> => markdown(await call(name, params))

/** The same call against rules that take precedence over the base fixtures. */
const renderWith = async (rules: FixtureRule[], name: string, params: ToolParams): Promise<string> => {
	live.unshift(...rules)
	try {
		return await render(name, params)
	} finally {
		live.splice(0, rules.length)
	}
}

// Each tool, its required params, and the sibling its description names.
const REGISTERED: Array<[string, Array<string>, string]> = [
	[OVERVIEW, [], ERROR_DETAIL],
	[ERROR_DETAIL, ["tool", "fingerprint"], OVERVIEW],
]

it.each(REGISTERED)("registers %s with its required params and framing", (name, required, sibling) => {
	const definition = definitionOf(name)
	const schema = toInputSchema(definition.schema)
	expect(schema.type).toBe("object")
	expect(schema.required ?? []).toEqual(required)
	expect(definition.description).toContain("AI agent tool call")
	expect(definition.description).toContain(sibling)
})

// A bad parameter, and the phrases the refusal has to name so a model can
// retry: a fingerprint that is not a decimal UInt64, a blank required tool
// (which would otherwise throw inside the request class), and a window wider
// than the search cap.
const REJECTED: Array<[string, string, ToolParams, Array<string>]> = [
	[
		"a fingerprint that is not a decimal UInt64",
		ERROR_DETAIL,
		{ tool: "search_docs", fingerprint: "0xdeadbeef" },
		["Invalid fingerprint", 'fingerprint="10453282193948324021"'],
	],
	[
		"a blank required tool",
		ERROR_DETAIL,
		{ ...WINDOW, tool: "   ", fingerprint: FINGERPRINT },
		["Invalid tool", 'tool="search_docs"'],
	],
	[
		"a window wider than the search cap",
		OVERVIEW,
		{ start_time: "2026-01-01 00:00:00", end_time: "2026-09-12 00:00:00" },
		["Time range too large"],
	],
]

it.each(REJECTED)("rejects %s with a message naming the fix", async (_case, name, params, phrases) => {
	const result = await call(name, params)
	expect(result.isError).toBe(true)
	for (const phrase of phrases) expect(markdown(result)).toContain(phrase)
})

describe("structured output", () => {
	it("decodes both tools' structuredContent with their output schemas", async () => {
		const overview = await call(OVERVIEW, { ...WINDOW, tool: "search_docs" })
		const decoded = Schema.decodeUnknownSync(GetAgentToolsOverviewOutput)(overview.structuredContent)
		expect(decoded.failureGroups?.groups[0]?.trend).toHaveLength(TREND_BUCKETS)
		const detail = await call(ERROR_DETAIL, {
			...WINDOW,
			tool: "search_docs",
			fingerprint: FINGERPRINT,
			payload_chars: 100,
		})
		const group = Schema.decodeUnknownSync(GetAgentToolErrorOutput)(detail.structuredContent)
		// The output carries the payload as the answer shows it, and its true size.
		expect(group.samples[0]?.arguments).toHaveLength(100)
		expect(group.samples[0]?.argumentsBytes).toBe(LONG_ARGUMENTS_BYTES)
	})
})

describe("get_agent_tools_overview rendering", () => {
	it("renders totals with deltas, the session share, a breakdown in ms and the tool's description", async () => {
		executedSql.length = 0
		const rendered = await render(OVERVIEW, WINDOW)
		// Calls 120 against 100 in the equal window before it, which is the window
		// shifted back by its own length.
		expect(rowCells(rendered, "Calls")).toEqual(["Calls", "120", "100", "+20.0%"])
		expect(executedSql.some((sql) => sql.includes(PREVIOUS_START))).toBe(true)
		// 6 of 120 against 2 of 100.
		// The change between two rates is points, not a percentage of a percentage.
		expect(rowCells(rendered, "Error rate")).toEqual(["Error rate", "5.00%", "2.00%", "+3.00 pp"])
		// Percentiles arrive in nanoseconds and render as ms.
		expect(rowCells(rendered, "p95").slice(1, 3)).toEqual(["900.0ms", "600.0ms"])
		expect(rendered).toContain("12 of 48 agent sessions in the window (25.00%)")
		expect(rowCells(rendered, "search_docs").slice(0, 7)).toEqual([
			"search_docs",
			"80",
			"9",
			"6",
			"7.50%",
			"12.0ms",
			"900.0ms",
		])
		// The follow-up names the worst error rate, not the busiest tool.
		expect(rendered).toMatch(
			/`get_agent_tools_overview start_time="[^"]+" end_time="[^"]+" tool="search_docs"`/,
		)
		// No tool selected: no failure groups were read, so none are rendered.
		expect(rendered).not.toContain("### Failure groups")
	})

	it("treats a blank filter as no filter", async () => {
		const rendered = await render(OVERVIEW, { ...WINDOW, tool: "", model: "  " })
		expect(rendered).toContain("Selection: tool: all tools")
		expect(rendered).not.toContain("model:")
	})

	it("answers an empty window with the share of sessions it covers", async () => {
		const rendered = await renderWith(EMPTY_RULES, OVERVIEW, WINDOW)
		expect(rendered).toContain("No agent tool calls matched this selection in the window.")
		expect(rendered).toContain("0 of 48 agent sessions in the window (0.00%)")
		expect(rendered).toContain("list_agent_sessions")
	})
})

// Selecting one tool turns the overview into that tool's failure ledger.
describe("get_agent_tools_overview failure groups", () => {
	it("buckets the trend by the window and keeps the window's first bucket", async () => {
		executedSql.length = 0
		const rendered = await render(OVERVIEW, { ...WINDOW, tool: "search_docs" })
		expect(rendered).toContain("Selection: tool: search_docs")
		expect(rendered).toContain(`Description: ${TOOL_DESCRIPTION}`)
		expect(rendered).toContain("### Failure groups of search_docs (1)")
		// The bucket is derived from the window, not from a parameter — and it is
		// the one that reaches `toStartOfInterval`.
		expect(TREND_BUCKET_SECONDS).toBe(1879)
		expect(rendered).toContain(`per ${TREND_BUCKET_SECONDS}s bucket`)
		expect(executedSql.some((sql) => sql.includes(`INTERVAL ${TREND_BUCKET_SECONDS} SECOND`))).toBe(true)
		const group = rowCells(rendered, FINGERPRINT)
		expect(group.slice(1, 6)).toEqual(["TimeoutError", "upstream timed out after 30s", "12", "4", "2"])
		expect(group[8]).toBe("15")
		// 1879s buckets over 12h: 3 failures in the first bucket of the window,
		// 4 at 06:00 and 5 at 08:00, gaps rendered as zeros.
		const expected = Array.from<number>({ length: TREND_BUCKETS }).fill(0)
		expected[0] = 3
		expected[11] = 4
		expected[15] = 5
		expect(group[9]).toBe(expected.join(","))
		// The follow-up keeps the window, so it opens the same group the table shows.
		expect(rendered).toContain(
			`\`get_agent_tool_error tool="search_docs" fingerprint="${FINGERPRINT}" start_time="${WINDOW.start_time}" end_time="${WINDOW.end_time}"\``,
		)
	})

	// The grid aligns its start DOWN to the bucket lattice, so a window starting
	// at 12:30 spans one bucket more than its width — and the window's first
	// bucket, the one the group's oldest failures are in, is the one at risk.
	it("keeps the first bucket of a window that does not start on a boundary", async () => {
		const width = Math.ceil((24 * 60 * 60) / (TREND_BUCKETS - 1)) * 1000
		const startMs = Date.parse(`${UNALIGNED_WINDOW.start_time.replace(" ", "T")}Z`)
		const firstBucket = new Date(Math.floor(startMs / width) * width).toISOString()
		const rendered = await renderWith(
			[
				{
					match: (sql) => sql.includes("numbered_tool_calls"),
					rows: [{ ...errorGroup, trend: { [firstBucket]: 7 } }],
				},
			],
			OVERVIEW,
			{ ...UNALIGNED_WINDOW, tool: "search_docs" },
		)
		const trend = (rowCells(rendered, FINGERPRINT)[9] ?? "").split(",")
		expect(trend).toHaveLength(TREND_BUCKETS)
		expect(trend[0]).toBe("7")
	})

	it("answers a tool with no failures", async () => {
		const rendered = await renderWith(
			[{ match: (sql) => sql.includes("numbered_tool_calls"), rows: [] }],
			OVERVIEW,
			{ ...WINDOW, tool: "search_docs" },
		)
		expect(rendered).toContain("No failed calls of `search_docs` in this window.")
	})
})

describe("get_agent_tool_error rendering", () => {
	const GROUP = { ...WINDOW, tool: "search_docs", fingerprint: FINGERPRINT }

	it("renders sessions, variants, the breakdown and clipped sample payloads", async () => {
		const rendered = await render(ERROR_DETAIL, { ...GROUP, payload_chars: 100 })
		expect(rendered).toContain(`## Tool failure group ${FINGERPRINT}`)
		expect(rowCells(rendered, "sess_a")).toEqual([
			"sess_a",
			"openai-agents",
			"researcher",
			"api",
			"6",
			SEEN,
		])
		expect(rendered).toContain("upstream timed out after 31s")
		expect(rowCells(rendered, "claude-sonnet-4")).toEqual(["claude-sonnet-4", "api", "9"])
		expect(rendered).toContain("duration 30.00s · status Error · error.type TimeoutError")
		// The payload is clipped to payload_chars and states its true size.
		expect(rendered).toContain("(12,000 bytes total)")
		expect(rendered).not.toContain(LONG_ARGUMENTS)
		// The session read is a seek: the sample's own instant, padded as a list
		// row's bounds are.
		expect(rendered).toMatch(
			/`get_agent_session session_id="sess_a" start_time="[\d-]+ [\d:.]+" end_time="[\d-]+ [\d:.]+"`/,
		)
		expect(rendered).toContain("`inspect_span")
	})

	it("clamps samples_limit and reports that more samples exist", async () => {
		executedSql.length = 0
		const rendered = await render(ERROR_DETAIL, { ...GROUP, samples_limit: 1 })
		// One row past the page is what tells the read there is a next page — on
		// the samples statement, not the variants read's constant `LIMIT 20`.
		expect(samplesSql().some((sql) => /\bLIMIT 2\b/.test(sql))).toBe(true)
		expect(rendered).toContain("More samples exist past this page")

		executedSql.length = 0
		await call(ERROR_DETAIL, { ...GROUP, samples_limit: 999 })
		expect(samplesSql().some((sql) => /\bLIMIT 101\b/.test(sql))).toBe(true)
	})

	it("clamps payload_chars to its default and its ceiling", async () => {
		// The clip appends one ellipsis to the characters it kept.
		expect(clippedArguments(await render(ERROR_DETAIL, GROUP))).toHaveLength(801)
		// The ceiling is the read's own cap, and the payload the read already cut
		// still renders with the ellipsis its byte total implies.
		expect(
			clippedArguments(await render(ERROR_DETAIL, { ...GROUP, payload_chars: 999_999 })),
		).toHaveLength(AI_TOOL_ERROR_PAYLOAD_MAX + 1)
	})

	it("says so when the span behind a sample was not retained", async () => {
		// The real path is a join miss: the index has the call, the payload read
		// returns no row for its span.
		const rendered = await renderWith(payloadsAre([]), ERROR_DETAIL, GROUP)
		expect(rendered).toContain("(not available: the span was not retained)")
	})

	it("tells a payload the span left empty from one it never carried", async () => {
		const rows = payloadRows.map((row) => ({ ...row, arguments: "", argumentsBytes: 0 }))
		const rendered = await renderWith(payloadsAre(rows), ERROR_DETAIL, GROUP)
		expect(rendered).toContain("(empty)")
		expect(rendered).not.toContain("(not available: the span was not retained)")
	})

	it("fences a sample payload that carries a code fence of its own", async () => {
		const rows = payloadRows.map((row) => ({
			...row,
			result: FENCED_RESULT,
			resultBytes: FENCED_RESULT.length,
		}))
		const rendered = await renderWith(payloadsAre(rows), ERROR_DETAIL, GROUP)
		// One backtick longer than the longest run inside the payload, which is
		// left intact.
		expect(rendered).toContain(`\`\`\`\`\n${FENCED_RESULT}`)
		expect(rendered).toContain("```js")
	})

	it("answers a fingerprint with nothing behind it", async () => {
		const rendered = await renderWith(EMPTY_RULES, ERROR_DETAIL, GROUP)
		expect(rendered).toContain("No failed calls of `search_docs` under this fingerprint")
	})
})

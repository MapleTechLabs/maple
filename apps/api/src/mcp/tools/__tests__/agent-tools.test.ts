import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import {
	installFakeWarehouse,
	restoreWarehouse,
	swappableFixtures,
	type FixtureRule,
} from "@/mcp/__evals__/fake-warehouse"
import { makeEvalRuntime, runToolDirect, type EvalRuntime } from "@/mcp/__evals__/eval-runtime"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import type { McpToolResult } from "@/mcp/tools/types"

// The three tool-analytics tools run through the registry the way a client
// reaches them: `runToolDirect` decodes the parameters against the published
// schema and dispatches by name, so a tool dropped from `registry.ts` fails
// here rather than at a customer's MCP client.

const OVERVIEW = "get_agent_tools_overview"
const ERROR_LIST = "list_agent_tool_errors"
const ERROR_DETAIL = "get_agent_tool_error"

const definitionOf = (name: string) => {
	const definition = mapleToolCatalog.find((candidate) => candidate.name === name)
	if (definition === undefined) throw new Error(`${name} is not in the MCP tool registry`)
	return definition
}

/** The rendered markdown alone — never the `__maple_ui` JSON mirror beside it. */
const markdown = (result: McpToolResult): string => result.content[0]?.text ?? ""

/** The `data` of the structured mirror, which the UI reads and the markdown only summarizes. */
const structured = (result: McpToolResult): Record<string, unknown> =>
	// SAFETY: `createDualContent` writes the second block as `{__maple_ui, tool, data}`,
	// and the fallback has the same shape for a result that carried no mirror.
	(JSON.parse(result.content[1]?.text ?? '{"data":{}}') as { data: Record<string, unknown> }).data

/**
 * The cells of the table row that starts with `first`. Asserting cell by cell
 * rather than against a whole rendered row keeps a new column from breaking
 * every table test.
 */
const rowCells = (rendered: string, first: string): ReadonlyArray<string> => {
	const line = rendered.split("\n").find((candidate) => candidate.startsWith(`| ${first} |`))
	if (line === undefined) throw new Error(`no table row starting with '${first}'`)
	return line.slice(2, -2).split(" | ")
}

// A 12h window so the trend's default bucket (window / 24) is a round 1800s and
// the fixtures' timestamps land in known buckets.
const WINDOW = { start_time: "2026-09-12 00:00:00", end_time: "2026-09-12 12:00:00" }
const WINDOW_SECONDS = 12 * 60 * 60

const totalsRows = [
	{
		period: "current",
		calls: 120,
		sessions: 12,
		errors: 6,
		p50: 12_000_000,
		p90: 300_000_000,
		p95: 900_000_000,
		firstSeen: "2026-09-12 01:00:00",
		lastSeen: "2026-09-12 11:30:00",
	},
	{
		period: "previous",
		calls: 100,
		sessions: 10,
		errors: 2,
		p50: 10_000_000,
		p90: 200_000_000,
		p95: 600_000_000,
		firstSeen: "2026-09-11 13:00:00",
		lastSeen: "2026-09-11 23:30:00",
	},
	{
		period: "window",
		calls: 0,
		sessions: 48,
		errors: 0,
		p50: 0,
		p90: 0,
		p95: 0,
		firstSeen: "",
		lastSeen: "",
	},
]

const TOOL_DESCRIPTION = "Search the product documentation"

const breakdownRows = [
	{
		key: "search_docs",
		calls: 80,
		sessions: 9,
		errors: 6,
		p50: 12_000_000,
		p90: 300_000_000,
		p95: 900_000_000,
		lastSeen: "2026-09-12 11:30:00",
		firstSeen: "2026-09-12 01:00:00",
	},
	{
		key: "run_query",
		calls: 40,
		sessions: 5,
		errors: 0,
		p50: 4_000_000,
		p90: 20_000_000,
		p95: 40_000_000,
		lastSeen: "2026-09-12 10:00:00",
		firstSeen: "2026-09-12 02:00:00",
	},
]

const seriesRows = [
	{
		bucket: "2026-09-12T09:00:00.000000Z",
		seriesKey: "search_docs",
		calls: 10,
		sessions: 3,
		errors: 1,
		p50: 12_000_000,
		p90: 300_000_000,
		p95: 500_000_000,
	},
	{
		bucket: "2026-09-12T10:00:00.000000Z",
		seriesKey: "search_docs",
		calls: 7,
		sessions: 2,
		errors: 0,
		p50: 11_000_000,
		p90: 200_000_000,
		p95: 400_000_000,
	},
]

const FINGERPRINT = "10453282193948324021"

const errorGroupRows = [
	{
		fingerprint: FINGERPRINT,
		errorType: "TimeoutError",
		message: "upstream timed out after 30s",
		calls: 12,
		sessions: 4,
		variants: 2,
		firstSeen: "2026-09-12 00:00:00",
		lastSeen: "2026-09-12 08:00:00",
		callsSince: 15,
		// Only the buckets that had a failure — including the window's FIRST,
		// which the grid used to drop.
		trend: {
			"2026-09-12T00:00:00.000000Z": 3,
			"2026-09-12T06:00:00.000000Z": 4,
			"2026-09-12T08:00:00.000000Z": 5,
		},
	},
]

const sessionRows = [
	{
		sessionId: "sess_a",
		vendorId: "openai-agents",
		agentName: "researcher",
		service: "api",
		hits: 6,
		lastSeen: "2026-09-12 08:00:00",
	},
]

const variantRows = [
	{ message: "upstream timed out after 30s", calls: 5, lastSeen: "2026-09-12 08:00:00" },
	{ message: "upstream timed out after 31s", calls: 4, lastSeen: "2026-09-12 07:00:00" },
]

const breakdownPairRows = [{ model: "claude-sonnet-4", service: "api", calls: 9 }]

// Longer than the `payload_chars` ceiling, so the clamp is observable.
const LONG_ARGUMENTS = `{"query":"${"x".repeat(12_000)}"}`

const occurrenceRows = [
	{
		timestamp: "2026-09-12 08:00:00.123456789",
		traceId: "a".repeat(32),
		spanId: "b".repeat(16),
		sessionId: "sess_a",
		vendorId: "openai-agents",
		agentName: "researcher",
		model: "claude-sonnet-4",
		service: "api",
		errorType: "TimeoutError",
		message: "upstream timed out after 30s",
		durationNs: 30_000_000_000,
	},
	{
		timestamp: "2026-09-12 07:00:00.000000000",
		traceId: "c".repeat(32),
		spanId: "d".repeat(16),
		sessionId: "sess_b",
		vendorId: "openai-agents",
		agentName: "researcher",
		model: "claude-sonnet-4",
		service: "api",
		errorType: "TimeoutError",
		message: "upstream timed out after 31s",
		durationNs: 31_000_000_000,
	},
]

// `statusCode` is Title case on the wire, like every other Maple span status.
const payloadRows = [
	{
		traceId: "a".repeat(32),
		spanId: "b".repeat(16),
		statusCode: "Error",
		arguments: LONG_ARGUMENTS,
		argumentsBytes: 4096,
		result: "TimeoutError: upstream timed out",
		resultBytes: 32,
	},
	{
		traceId: "c".repeat(32),
		spanId: "d".repeat(16),
		statusCode: "Error",
		arguments: `{"query":"short"}`,
		argumentsBytes: 17,
		result: "TimeoutError: upstream timed out",
		resultBytes: 32,
	},
]

/** A span the retention dropped: the row exists, its payloads do not. */
const droppedPayloadRows = payloadRows.map((row) => ({
	...row,
	arguments: "",
	argumentsBytes: 0,
	result: "",
	resultBytes: 0,
}))

/** Every statement the fake answered, so a test can assert what it carried. */
const executedSql: string[] = []

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
	// Both series shapes: split by a key (which ranks) and `none` (which does not).
	{ match: record((sql) => sql.includes("AS seriesKey")), rows: seriesRows },
	{ match: record((sql) => sql.includes("numbered_tool_calls")), rows: errorGroupRows },
	{ match: record((sql) => sql.includes("GROUP BY sessionId")), rows: sessionRows },
	{ match: record((sql) => sql.includes("GROUP BY message")), rows: variantRows },
	{ match: record((sql) => sql.includes("GROUP BY model, service")), rows: breakdownPairRows },
	// The samples page is the one failing-calls read that groups by nothing.
	{ match: record((sql) => sql.includes("failing_tool_calls")), rows: occurrenceRows },
]

const EMPTY_RULES: FixtureRule[] = [{ match: () => true, rows: [] }]

const { rule, withRules } = swappableFixtures(fixtures)

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([rule])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: Record<string, string | number | boolean>) =>
	runToolDirect(rt, name, params) as Promise<McpToolResult>

describe("agent tool analytics registration", () => {
	it("registers three tools with object input schemas and the expected required params", () => {
		for (const name of [OVERVIEW, ERROR_LIST, ERROR_DETAIL]) {
			expect(toInputSchema(definitionOf(name).schema).type, name).toBe("object")
		}
		expect(toInputSchema(definitionOf(OVERVIEW).schema).required ?? []).toEqual([])
		expect(toInputSchema(definitionOf(ERROR_LIST).schema).required).toEqual(["tool"])
		expect(toInputSchema(definitionOf(ERROR_DETAIL).schema).required).toEqual(["tool", "fingerprint"])
	})

	it("says what an AI agent tool call is, and names the follow-up tool", () => {
		for (const name of [OVERVIEW, ERROR_LIST, ERROR_DETAIL]) {
			expect(definitionOf(name).description, name).toContain("AI agent tool call")
		}
		expect(definitionOf(OVERVIEW).description).toContain("list_agent_tool_errors")
		expect(definitionOf(ERROR_LIST).description).toContain("get_agent_tool_error")
		expect(definitionOf(ERROR_DETAIL).description).toContain("list_agent_tool_errors")
	})

	it("publishes `split` as an enum, so a client reads the three values off the schema", () => {
		const published = toInputSchema(definitionOf(OVERVIEW).schema) as {
			properties: Record<string, { enum?: ReadonlyArray<string> }>
		}
		expect(published.properties.split?.enum).toEqual(["tool", "model", "none"])
	})
})

describe("agent tool analytics validation", () => {
	it("rejects a fingerprint that is not a decimal UInt64, with an example", async () => {
		const result = await call(ERROR_DETAIL, { tool: "search_docs", fingerprint: "0xdeadbeef" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid fingerprint")
		expect(markdown(result)).toContain('fingerprint="10453282193948324021"')
	})

	it("rejects a split the schema does not publish", async () => {
		const result = await call(OVERVIEW, { split: "service", bucket_seconds: 3600 })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid parameters")
		expect(markdown(result)).toContain("split")
	})

	it("rejects a sub-second bucket", async () => {
		const result = await call(OVERVIEW, { ...WINDOW, bucket_seconds: 0.5 })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid bucket_seconds")
	})

	it("rejects a bucket wider than the window, naming the range", async () => {
		const result = await call(ERROR_LIST, {
			...WINDOW,
			tool: "search_docs",
			bucket_seconds: WINDOW_SECONDS + 1,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain(`between 1 and ${WINDOW_SECONDS}`)
	})

	it("rejects a blank required tool rather than failing inside the request", async () => {
		const result = await call(ERROR_LIST, { ...WINDOW, tool: "   " })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid tool")
		expect(markdown(result)).toContain('tool="search_docs"')
	})

	it("rejects a window wider than the search cap", async () => {
		const result = await call(ERROR_LIST, {
			tool: "search_docs",
			start_time: "2026-01-01 00:00:00",
			end_time: "2026-09-12 00:00:00",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Time range too large")
	})
})

describe("get_agent_tools_overview rendering", () => {
	it("renders totals with deltas, the session share and a breakdown in ms", async () => {
		const rendered = markdown(await call(OVERVIEW, WINDOW))
		// Calls 120 against 100 in the equal window before it.
		expect(rowCells(rendered, "Calls")).toEqual(["Calls", "120", "100", "+20.0%"])
		// Percentiles arrive in nanoseconds and render as ms.
		expect(rowCells(rendered, "p95").slice(1, 3)).toEqual(["900.0ms", "600.0ms"])
		expect(rendered).toContain("12 of 48 agent sessions in the window (25.00%)")
		const tool = rowCells(rendered, "search_docs")
		expect(tool.slice(0, 7)).toEqual(["search_docs", "80", "9", "6", "7.50%", "12.0ms", "900.0ms"])
		// The follow-up names the worst error rate, not the busiest tool.
		expect(rendered).toContain('`list_agent_tool_errors tool="search_docs"`')
	})

	it("treats a blank filter as no filter", async () => {
		const rendered = markdown(await call(OVERVIEW, { ...WINDOW, tool: "", model: "  " }))
		expect(rendered).toContain("Selection: tool: all tools")
		expect(rendered).not.toContain("model:")
	})

	it("adds a series only when bucket_seconds is given, split as asked", async () => {
		const without = markdown(await call(OVERVIEW, WINDOW))
		expect(without).not.toContain("### Series")
		const withSeries = markdown(await call(OVERVIEW, { ...WINDOW, bucket_seconds: 3600 }))
		expect(withSeries).toContain("### Series (3600s buckets, split by tool)")
		expect(rowCells(withSeries, "2026-09-12 09:00:00")).toEqual([
			"2026-09-12 09:00:00",
			"search_docs",
			"10",
			"1",
			"500.0ms",
		])
		const byModel = markdown(await call(OVERVIEW, { ...WINDOW, bucket_seconds: 3600, split: "model" }))
		expect(byModel).toContain("split by model")
		const merged = markdown(await call(OVERVIEW, { ...WINDOW, bucket_seconds: 3600, split: "none" }))
		expect(merged).toContain("split by none")
	})

	it("names the selected tool's description", async () => {
		const result = await call(OVERVIEW, { ...WINDOW, tool: "search_docs" })
		expect(markdown(result)).toContain(`Description: ${TOOL_DESCRIPTION}`)
		expect(markdown(result)).toContain("Selection: tool: search_docs")
		expect(structured(result).description).toBe(TOOL_DESCRIPTION)
	})

	it("answers an empty window without a breakdown", async () => {
		const rendered = await withRules(EMPTY_RULES, async () => markdown(await call(OVERVIEW, WINDOW)))
		expect(rendered).toContain("No agent tool calls matched this selection in the window.")
		expect(rendered).toContain("get_agent_sessions_overview")
	})
})

describe("list_agent_tool_errors rendering", () => {
	it("renders a group whose trend keeps the window's first bucket", async () => {
		const rendered = markdown(await call(ERROR_LIST, { ...WINDOW, tool: "search_docs" }))
		expect(rendered).toContain("## Tool failures: search_docs")
		const cells = rowCells(rendered, FINGERPRINT)
		expect(cells.slice(1, 4)).toEqual(["TimeoutError", "upstream timed out after 30s", "12"])
		// 1800s buckets over 12h: 3 failures in the first bucket of the window,
		// 4 at 06:00 and 5 at 08:00, gaps rendered as zeros.
		const expected = Array.from<number>({ length: 24 }).fill(0)
		expected[0] = 3
		expected[12] = 4
		expected[16] = 5
		expect(cells[cells.length - 1]).toBe(expected.join(","))
		expect(rendered).toContain(`\`get_agent_tool_error tool="search_docs" fingerprint="${FINGERPRINT}"\``)
	})

	it("bounds the trend grid at 24 buckets however narrow the bucket", async () => {
		const rendered = markdown(
			await call(ERROR_LIST, { ...WINDOW, tool: "search_docs", bucket_seconds: 1 }),
		)
		const cells = rowCells(rendered, FINGERPRINT)
		expect(cells[cells.length - 1]?.split(",")).toHaveLength(24)
	})

	it("answers a tool with no failures", async () => {
		const rendered = await withRules(EMPTY_RULES, async () =>
			markdown(await call(ERROR_LIST, { ...WINDOW, tool: "search_docs" })),
		)
		expect(rendered).toContain("No failed calls of `search_docs` in this window.")
	})
})

describe("get_agent_tool_error rendering", () => {
	it("renders sessions, variants, the breakdown and clipped sample payloads", async () => {
		const rendered = markdown(
			await call(ERROR_DETAIL, {
				...WINDOW,
				tool: "search_docs",
				fingerprint: FINGERPRINT,
				payload_chars: 100,
			}),
		)
		expect(rendered).toContain(`## Tool failure group ${FINGERPRINT}`)
		expect(rowCells(rendered, "sess_a")).toEqual([
			"sess_a",
			"openai-agents",
			"researcher",
			"api",
			"6",
			"2026-09-12 08:00:00",
		])
		expect(rendered).toContain("upstream timed out after 31s")
		expect(rowCells(rendered, "claude-sonnet-4")).toEqual(["claude-sonnet-4", "api", "9"])
		expect(rendered).toContain("duration 30.00s · status Error · error.type TimeoutError")
		// The payload is clipped to payload_chars and states its true size.
		expect(rendered).toContain("(4,096 bytes total)")
		expect(rendered).not.toContain(LONG_ARGUMENTS)
		expect(rendered).toContain('`get_agent_session session_id="sess_a"`')
		expect(rendered).toContain("`inspect_agent_session_span")
	})

	it("clamps samples_limit and reports that more samples exist", async () => {
		executedSql.length = 0
		const rendered = markdown(
			await call(ERROR_DETAIL, {
				...WINDOW,
				tool: "search_docs",
				fingerprint: FINGERPRINT,
				samples_limit: 1,
			}),
		)
		// One row past the page is what tells the read there is a next page.
		expect(executedSql.some((sql) => sql.includes("LIMIT 2"))).toBe(true)
		expect(rendered).toContain("More samples exist past this page")

		executedSql.length = 0
		await call(ERROR_DETAIL, {
			...WINDOW,
			tool: "search_docs",
			fingerprint: FINGERPRINT,
			samples_limit: 999,
		})
		expect(executedSql.some((sql) => sql.includes("LIMIT 101"))).toBe(true)
	})

	it("clamps payload_chars to its default and its ceiling", async () => {
		const defaulted = await call(ERROR_DETAIL, {
			...WINDOW,
			tool: "search_docs",
			fingerprint: FINGERPRINT,
			payload_chars: 0,
		})
		const defaultedSamples = structured(defaulted).samples as ReadonlyArray<{ arguments: string }>
		expect(defaultedSamples[0]?.arguments).toHaveLength(800)

		const huge = await call(ERROR_DETAIL, {
			...WINDOW,
			tool: "search_docs",
			fingerprint: FINGERPRINT,
			payload_chars: 999_999,
		})
		const hugeSamples = structured(huge).samples as ReadonlyArray<{ arguments: string }>
		expect(hugeSamples[0]?.arguments).toHaveLength(10_000)
	})

	it("narrows the samples to one session", async () => {
		executedSql.length = 0
		const result = await call(ERROR_DETAIL, {
			...WINDOW,
			tool: "search_docs",
			fingerprint: FINGERPRINT,
			session: "sess_a",
		})
		expect(executedSql.some((sql) => sql.includes("sess_a"))).toBe(true)
		expect(markdown(result)).toContain("### Samples")
	})

	it("says so when the span behind a sample was not retained", async () => {
		const rendered = await withRules(
			[{ match: (sql) => sql.includes("trace_detail_spans"), rows: droppedPayloadRows }, ...fixtures],
			async () =>
				markdown(
					await call(ERROR_DETAIL, {
						...WINDOW,
						tool: "search_docs",
						fingerprint: FINGERPRINT,
					}),
				),
		)
		expect(rendered).toContain("(not available — the span was not retained)")
	})

	it("answers a fingerprint with nothing behind it", async () => {
		const rendered = await withRules(EMPTY_RULES, async () =>
			markdown(await call(ERROR_DETAIL, { ...WINDOW, tool: "search_docs", fingerprint: FINGERPRINT })),
		)
		expect(rendered).toContain("No failed calls of `search_docs` under this fingerprint")
	})
})

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema as S, type Schema } from "effect"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "@/mcp/__evals__/fake-warehouse"
import { FIXTURES } from "@/mcp/__evals__/utils"
import { Env } from "@/platform/Env"
import { createTestDb } from "@/platform/test-pglite"
import { WarehouseLive } from "@/runtime/warehouse-layer"
import { OrgId, UserId } from "@maple/domain/http"
import type { TenantContext } from "@/services/auth/tenant-context"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { toInputSchema } from "@/mcp/tools/registry"
import type { McpToolRequirements } from "@/mcp/tools/runtime-requirements"
import type { McpToolRegistrar, McpToolResult } from "@/mcp/tools/types"
import { registerGetAgentToolsOverviewTool } from "@/mcp/tools/get-agent-tools-overview"
import { registerListAgentToolErrorsTool } from "@/mcp/tools/list-agent-tool-errors"
import { registerGetAgentToolErrorTool } from "@/mcp/tools/get-agent-tool-error"

// The three tool-analytics tools are not in the registry yet (the wiring lands
// with the sessions tools), so each handler is captured from its registrar and
// driven directly — validation paths against an empty context, rendering
// against the eval runtime + fake warehouse.

type ToolInput = Record<string, string | number | boolean | undefined>

const captureTool = (register: (server: McpToolRegistrar) => void) => {
	let captured:
		| {
				name: string
				description: string
				schema: Schema.Top
				handler: (params: ToolInput) => Effect.Effect<McpToolResult, unknown, unknown>
		  }
		| undefined
	register({
		tool: (name, description, schema, handler) => {
			// SAFETY: the inputs below are shaped by each tool's own Struct; the
			// registrar erases the parameter type, so it is re-widened here.
			captured = { name, description, schema, handler: (params) => handler(params as never) }
		},
	})
	if (!captured) throw new Error("tool did not register")
	return captured
}

const overview = captureTool(registerGetAgentToolsOverviewTool)
const errorList = captureTool(registerListAgentToolErrorsTool)
const errorDetail = captureTool(registerGetAgentToolErrorTool)

/** Validation paths return before any service is read, so an empty context is enough. */
const runBare = (effect: Effect.Effect<McpToolResult, unknown, unknown>) =>
	Effect.runPromise(
		(effect as Effect.Effect<McpToolResult, unknown, McpToolRequirements>).pipe(
			Effect.provide(Context.empty() as Context.Context<McpToolRequirements>),
		),
	)

const text = (result: McpToolResult) => result.content.map((c) => ("text" in c ? c.text : "")).join("\n")

// A 12h window so the trend's default bucket (window / 24) is a round 1800s and
// the fixtures' timestamps land in known buckets.
const WINDOW = { start_time: "2026-09-12 00:00:00", end_time: "2026-09-12 12:00:00" }

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
		calls: 9,
		sessions: 4,
		variants: 2,
		firstSeen: "2026-09-12 06:00:00",
		lastSeen: "2026-09-12 08:00:00",
		callsSince: 15,
		// Only the buckets that had a failure; 06:00 and 08:00 of the window.
		trend: { "2026-09-12T06:00:00.000000Z": 4, "2026-09-12T08:00:00.000000Z": 5 },
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

const LONG_ARGUMENTS = `{"query":"${"x".repeat(900)}"}`

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

const payloadRows = [
	{
		traceId: "a".repeat(32),
		spanId: "b".repeat(16),
		statusCode: "ERROR",
		arguments: LONG_ARGUMENTS,
		argumentsBytes: 4096,
		result: "TimeoutError: upstream timed out",
		resultBytes: 32,
	},
	{
		traceId: "c".repeat(32),
		spanId: "d".repeat(16),
		statusCode: "ERROR",
		arguments: `{"query":"short"}`,
		argumentsBytes: 17,
		result: "TimeoutError: upstream timed out",
		resultBytes: 32,
	},
]

/** Every statement the fake answered, so a test can assert the limit it carried. */
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
	{ match: record((sql) => sql.includes("tool_calls_current")), rows: totalsRows },
	{ match: record((sql) => sql.includes("tool_breakdown")), rows: breakdownRows },
	{ match: record((sql) => sql.includes("series_ranking")), rows: seriesRows },
	{ match: record((sql) => sql.includes("numbered_tool_calls")), rows: errorGroupRows },
	{ match: record((sql) => sql.includes("GROUP BY sessionId")), rows: sessionRows },
	{ match: record((sql) => sql.includes("GROUP BY message")), rows: variantRows },
	{ match: record((sql) => sql.includes("GROUP BY model, service")), rows: breakdownPairRows },
	// The samples page is the one failing-calls read that groups by nothing.
	{ match: record((sql) => sql.includes("failing_tool_calls")), rows: occurrenceRows },
]

/**
 * The eval runtime's layer exposes only `McpToolExecutor`, which dispatches by
 * registry name — and these three tools are not registered yet. So the runtime
 * here is the same pieces (PGlite + test config) over the warehouse layer
 * alone, which is every service these handlers read.
 */
const makeWarehouseRuntime = () => {
	const testDb = createTestDb()
	const configLive = ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-eval.tinybird.co",
			TINYBIRD_TOKEN: "eval-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "eval-root-password",
			MAPLE_DEFAULT_ORG_ID: FIXTURES.orgId,
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "eval-lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const runtime = ManagedRuntime.make(
		WarehouseLive.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer, configLive))),
	)
	const tenant: TenantContext = {
		orgId: S.decodeSync(OrgId)(FIXTURES.orgId),
		userId: S.decodeSync(UserId)("internal-service"),
		roles: [],
		authMode: "self_hosted",
	}
	return {
		runtime,
		tenant,
		dispose: async () => {
			await runtime.dispose()
			await testDb.close()
		},
	}
}

let rt: ReturnType<typeof makeWarehouseRuntime>

const runTool = async (
	tool: { handler: (params: ToolInput) => Effect.Effect<McpToolResult, unknown, unknown> },
	params: ToolInput,
): Promise<McpToolResult> =>
	rt.runtime.runPromise(
		(tool.handler(params) as Effect.Effect<McpToolResult, unknown, CurrentMcpTenant>).pipe(
			Effect.provideService(CurrentMcpTenant, rt.tenant),
		),
	)

/**
 * The warehouse client is built once with the layer, so the fake is installed
 * once and the rule set it consults is swapped per test instead.
 */
let rules: FixtureRule[] = fixtures
let matchedRows: ReadonlyArray<unknown> = []
const dynamicFixture: FixtureRule = {
	match: (sql) => {
		const rule = rules.find((candidate) => candidate.match(sql))
		matchedRows = rule === undefined ? [] : rule.rows
		return rule !== undefined
	},
	// Read only after `match` answered true, so these are that rule's rows.
	get rows() {
		return matchedRows
	},
}

/** Run `body` against a narrower rule set — an empty read, usually. */
const withRules = async <A>(temporary: FixtureRule[], body: () => Promise<A>): Promise<A> => {
	rules = temporary
	try {
		return await body()
	} finally {
		rules = fixtures
	}
}

beforeAll(() => {
	installFakeWarehouse([dynamicFixture])
	rt = makeWarehouseRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

describe("agent tool analytics registration", () => {
	it("registers three tools with object input schemas and the expected required params", () => {
		expect(overview.name).toBe("get_agent_tools_overview")
		expect(errorList.name).toBe("list_agent_tool_errors")
		expect(errorDetail.name).toBe("get_agent_tool_error")
		for (const tool of [overview, errorList, errorDetail]) {
			expect(toInputSchema(tool.schema).type, tool.name).toBe("object")
		}
		expect(toInputSchema(overview.schema).required ?? []).toEqual([])
		expect(toInputSchema(errorList.schema).required).toEqual(["tool"])
		expect(toInputSchema(errorDetail.schema).required).toEqual(["tool", "fingerprint"])
	})

	it("says what an AI agent tool call is, and names the follow-up tool", () => {
		for (const tool of [overview, errorList, errorDetail]) {
			expect(tool.description, tool.name).toContain("AI agent tool call")
		}
		expect(overview.description).toContain("list_agent_tool_errors")
		expect(errorList.description).toContain("get_agent_tool_error")
		expect(errorDetail.description).toContain("list_agent_tool_errors")
	})
})

describe("agent tool analytics validation", () => {
	it("rejects a fingerprint that is not a decimal UInt64, with an example", async () => {
		const result = await runBare(errorDetail.handler({ tool: "search_docs", fingerprint: "0xdeadbeef" }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid fingerprint")
		expect(text(result)).toContain('fingerprint="10453282193948324021"')
	})

	it("rejects an unknown series split", async () => {
		const result = await runBare(overview.handler({ split: "service", bucket_seconds: 3600 }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid split")
	})

	it("rejects a sub-second bucket", async () => {
		const result = await runBare(overview.handler({ bucket_seconds: 0.5 }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid bucket_seconds")
	})

	it("rejects a window wider than the search cap", async () => {
		const result = await runBare(
			errorList.handler({
				tool: "search_docs",
				start_time: "2026-01-01 00:00:00",
				end_time: "2026-09-12 00:00:00",
			}),
		)
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Time range too large")
	})
})

describe("get_agent_tools_overview rendering", () => {
	it("renders totals with deltas, the session share and a breakdown in ms", async () => {
		const result = await runTool(overview, WINDOW)
		const rendered = text(result)
		// Calls 120 against 100 in the equal window before it.
		expect(rendered).toContain("| Calls | 120 | 100 | +20.0% |")
		// Percentiles arrive in nanoseconds and render as ms.
		expect(rendered).toContain("| p95 | 900.0ms | 600.0ms |")
		expect(rendered).toContain("12 of 48 agent sessions in the window (25.00%)")
		expect(rendered).toContain("| search_docs | 80 | 9 | 6 | 7.50% | 12.0ms | 900.0ms |")
		// The follow-up names the worst error rate, not the busiest tool.
		expect(rendered).toContain('`list_agent_tool_errors tool="search_docs"`')
	})

	it("adds a series only when bucket_seconds is given", async () => {
		const without = text(await runTool(overview, WINDOW))
		expect(without).not.toContain("### Series")
		const withSeries = text(await runTool(overview, { ...WINDOW, bucket_seconds: 3600 }))
		expect(withSeries).toContain("### Series (3600s buckets, split by tool)")
		expect(withSeries).toContain("| 2026-09-12 09:00:00 | search_docs | 10 | 1 | 500.0ms |")
	})

	it("answers an empty window without a breakdown", async () => {
		const rendered = await withRules([{ match: () => true, rows: [] }], async () =>
			text(await runTool(overview, WINDOW)),
		)
		expect(rendered).toContain("No agent tool calls matched this selection in the window.")
		expect(rendered).toContain("get_agent_sessions_overview")
	})
})

describe("list_agent_tool_errors rendering", () => {
	it("renders a group with a gap-filled trend and the follow-up call", async () => {
		const rendered = text(await runTool(errorList, { ...WINDOW, tool: "search_docs" }))
		expect(rendered).toContain("## Tool failures: search_docs")
		expect(rendered).toContain(FINGERPRINT)
		expect(rendered).toContain("TimeoutError")
		expect(rendered).toContain("upstream timed out after 30s")
		// 4 failures at 06:00 and 5 at 08:00, three empty 1800s buckets between.
		expect(rendered).toContain("4,0,0,0,5")
		expect(rendered).toContain(`\`get_agent_tool_error tool="search_docs" fingerprint="${FINGERPRINT}"\``)
	})

	it("answers a tool with no failures", async () => {
		const rendered = await withRules([{ match: () => true, rows: [] }], async () =>
			text(await runTool(errorList, { ...WINDOW, tool: "search_docs" })),
		)
		expect(rendered).toContain("No failed calls of `search_docs` in this window.")
	})
})

describe("get_agent_tool_error rendering", () => {
	it("renders sessions, variants, the breakdown and clipped sample payloads", async () => {
		const rendered = text(
			await runTool(errorDetail, {
				...WINDOW,
				tool: "search_docs",
				fingerprint: FINGERPRINT,
				payload_chars: 100,
			}),
		)
		expect(rendered).toContain(`## Tool failure group ${FINGERPRINT}`)
		expect(rendered).toContain("| sess_a | openai-agents | researcher | api | 6 |")
		expect(rendered).toContain("upstream timed out after 31s")
		expect(rendered).toContain("| claude-sonnet-4 | api | 9 |")
		expect(rendered).toContain("duration 30.00s · status ERROR · error.type TimeoutError")
		// The payload is clipped to payload_chars and states its true size.
		expect(rendered).toContain("(4,096 bytes total)")
		expect(rendered).not.toContain(LONG_ARGUMENTS)
		expect(rendered).toContain('`get_agent_session session_id="sess_a"`')
		expect(rendered).toContain("`inspect_agent_session_span")
	})

	it("clamps samples_limit and reports that more samples exist", async () => {
		executedSql.length = 0
		const rendered = text(
			await runTool(errorDetail, {
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
		await runTool(errorDetail, {
			...WINDOW,
			tool: "search_docs",
			fingerprint: FINGERPRINT,
			samples_limit: 999,
		})
		expect(executedSql.some((sql) => sql.includes("LIMIT 101"))).toBe(true)
	})

	it("answers a fingerprint with nothing behind it", async () => {
		const rendered = await withRules([{ match: () => true, rows: [] }], async () =>
			text(await runTool(errorDetail, { ...WINDOW, tool: "search_docs", fingerprint: FINGERPRINT })),
		)
		expect(rendered).toContain("No failed calls of `search_docs` under this fingerprint")
	})
})

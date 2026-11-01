import type { McpCallRow, McpServerOverview, McpServerRow, McpToolDetail } from "../page/mcp/data"
import type { ToolSeriesPoint } from "../page/agent-sessions/tools-kit/model"

// `/lab/mcp`: `maple-ai`'s MCP spans from Nov 1, 2026 09:33 to 12:35 UTC, as the warehouse holds them
// (`mcp.method.name` SERVER spans, 15-minute buckets). The spec spans start at 09:33; there is nothing
// before it to compare against.

const MS = 1_000_000
const BUCKET_MS = 15 * 60_000
const FIRST_BUCKET = Date.UTC(2026, 10, 1, 9, 30)
export const MCP_NOW = Date.UTC(2026, 10, 1, 12, 35)
const at = (hour: number, minute: number, second = 0) => Date.UTC(2026, 10, 1, hour, minute, second)

/** Bucket index (0 = 09:30 UTC) → its epoch ms. */
const bucketAt = (index: number) => FIRST_BUCKET + index * BUCKET_MS
const BUCKETS = 13

type Reading = readonly [calls: number, errors: number, p50: number, p90: number, p95: number]

/** A merged series over every bucket, zeros where nothing ran. */
const series = (
	readings: Readonly<Record<number, Reading>>,
	seriesKey = "all",
): ReadonlyArray<ToolSeriesPoint> =>
	Array.from({ length: BUCKETS }, (_, index) => {
		const [calls, errors, p50, p90, p95] = readings[index] ?? [0, 0, 0, 0, 0]
		return {
			bucket: bucketAt(index),
			seriesKey,
			calls,
			sessions: 0,
			errors,
			p50: p50 * MS,
			p90: p90 * MS,
			p95: p95 * MS,
		}
	})

/** One series per client, calls only. */
const split = (
	byClient: Readonly<Record<string, Readonly<Record<number, number>>>>,
): ReadonlyArray<ToolSeriesPoint> =>
	Object.entries(byClient).flatMap(([client, buckets]) =>
		Array.from({ length: BUCKETS }, (_, index) => ({
			bucket: bucketAt(index),
			seriesKey: client,
			calls: buckets[index] ?? 0,
			sessions: 0,
			errors: 0,
			p50: 0,
			p90: 0,
			p95: 0,
		})),
	)

const call = (
	timeMs: number,
	client: string,
	requestId: string,
	durationMs: number,
	errorType: string | null,
	traceId: string,
): McpCallRow => ({ timeMs, client, requestId, durationNs: durationMs * MS, errorType, traceId })

const sparkOf = (buckets: Readonly<Record<number, number>>) =>
	Array.from({ length: BUCKETS }, (_, index) => buckets[index] ?? 0)

const SERVER_SERIES = series({
	0: [5, 2, 189, 225, 239],
	8: [8, 0, 230, 330, 352],
	9: [101, 0, 107, 300, 404],
	10: [169, 3, 134, 360, 507],
	11: [95, 2, 118, 700, 1196],
	12: [9, 0, 156, 250, 304],
})

export const MCP_OVERVIEW: McpServerOverview = {
	service: "maple-ai",
	protocolVersion: "2025-06-18",
	transport: "HTTP",
	firstSpanMs: at(9, 33),
	nowMs: MCP_NOW,
	series: SERVER_SERIES,
	clientSeries: split({
		curl: { 9: 75, 10: 140, 11: 57 },
		"estate-console": { 9: 14, 10: 16, 11: 15, 12: 5 },
		Bun: { 11: 23, 12: 2 },
		"Node (undici)": { 8: 8, 9: 12 },
		"Claude Code": { 10: 13, 12: 2 },
		"preview-verifier": { 0: 5 },
	}),
	totals: { calls: 387, errors: 7, statusErrors: 0, p50: 124 * MS, p90: 363 * MS, p95: 600 * MS },
	tools: [
		{
			tool: "list_error_incidents",
			calls: 144,
			errors: 0,
			p50: 44 * MS,
			p90: 180 * MS,
			p95: 249 * MS,
			topError: null,
			lastCallMs: at(12, 29),
			spark: sparkOf({ 9: 48, 10: 48, 11: 48 }),
		},
		{
			tool: "run_sql",
			calls: 115,
			errors: 7,
			p50: 198 * MS,
			p90: 640 * MS,
			p95: 1099 * MS,
			topError: "tool_error",
			lastCallMs: at(12, 31),
			spark: sparkOf({ 0: 2, 8: 8, 9: 22, 10: 58, 11: 21, 12: 4 }),
		},
		{
			tool: "explore_attributes",
			calls: 26,
			errors: 0,
			p50: 132 * MS,
			p90: 280 * MS,
			p95: 326 * MS,
			topError: null,
			lastCallMs: at(12, 7),
			spark: sparkOf({ 10: 26 }),
		},
		{
			tool: "list_alert_incidents",
			calls: 20,
			errors: 0,
			p50: 107 * MS,
			p90: 250 * MS,
			p95: 333 * MS,
			topError: null,
			lastCallMs: at(12, 30),
			spark: sparkOf({ 9: 6, 10: 7, 11: 6, 12: 1 }),
		},
		{
			tool: "list_services",
			calls: 16,
			errors: 0,
			p50: 180 * MS,
			p90: 330 * MS,
			p95: 378 * MS,
			topError: null,
			lastCallMs: at(12, 30),
			spark: sparkOf({ 0: 3, 9: 6, 10: 3, 11: 3, 12: 1 }),
		},
		{
			tool: "search_traces",
			calls: 13,
			errors: 0,
			p50: 182 * MS,
			p90: 260 * MS,
			p95: 291 * MS,
			topError: null,
			lastCallMs: at(12, 7),
			spark: sparkOf({ 9: 1, 10: 12 }),
		},
		{
			tool: "list_alert_rules",
			calls: 10,
			errors: 0,
			p50: 57 * MS,
			p90: 310 * MS,
			p95: 525 * MS,
			topError: null,
			lastCallMs: at(12, 30),
			spark: sparkOf({ 9: 3, 10: 3, 11: 3, 12: 1 }),
		},
		{
			tool: "ingest_freshness",
			calls: 10,
			errors: 0,
			p50: 325 * MS,
			p90: 720 * MS,
			p95: 1035 * MS,
			topError: null,
			lastCallMs: at(12, 30),
			spark: sparkOf({ 9: 3, 10: 3, 11: 3, 12: 1 }),
		},
		{
			tool: "find_errors",
			calls: 10,
			errors: 0,
			p50: 298 * MS,
			p90: 810 * MS,
			p95: 1102 * MS,
			topError: null,
			lastCallMs: at(12, 30),
			spark: sparkOf({ 9: 3, 10: 3, 11: 3, 12: 1 }),
		},
		{
			tool: "list_error_issues",
			calls: 10,
			errors: 0,
			p50: 270 * MS,
			p90: 350 * MS,
			p95: 387 * MS,
			topError: null,
			lastCallMs: at(12, 28),
			spark: sparkOf({ 9: 4, 10: 3, 11: 3 }),
		},
		{
			tool: "list_uptime_monitors",
			calls: 9,
			errors: 0,
			p50: 78 * MS,
			p90: 110 * MS,
			p95: 128 * MS,
			topError: null,
			lastCallMs: at(12, 28),
			spark: sparkOf({ 9: 3, 10: 3, 11: 3 }),
		},
		{
			tool: "service_deployments",
			calls: 3,
			errors: 0,
			p50: 255 * MS,
			p90: 560 * MS,
			p95: 725 * MS,
			topError: null,
			lastCallMs: at(12, 27),
			spark: sparkOf({ 9: 1, 11: 2 }),
		},
		{
			tool: "search_logs",
			calls: 1,
			errors: 0,
			p50: 1048 * MS,
			p90: 1048 * MS,
			p95: 1048 * MS,
			topError: null,
			lastCallMs: at(11, 51),
			spark: sparkOf({ 9: 1 }),
		},
	],
	clients: [
		{ name: "curl", kind: "script", calls: 272, errors: 2 },
		{ name: "estate-console", kind: "unknown", calls: 50, errors: 0 },
		{ name: "Bun", kind: "script", calls: 25, errors: 2 },
		{ name: "Node (undici)", kind: "script", calls: 20, errors: 0 },
		{ name: "Claude Code", kind: "agent", calls: 15, errors: 1 },
		{ name: "preview-verifier", kind: "unknown", calls: 5, errors: 2 },
	],
	initializers: [
		{ name: "Claude Code", count: 75 },
		{ name: "estate-console", count: 10 },
		{ name: "executor-mcp", count: 5 },
		{ name: "factory-cli", count: 1 },
		{ name: "preview-verifier", count: 1 },
		{ name: "pi", count: 1 },
	],
	failures: [
		{
			label: "Tool errors",
			codes: ["error.type = tool_error"],
			detail: "The tool answered with isError: true.",
			count: 7,
		},
		{
			label: "JSON-RPC errors",
			codes: ["-32603"],
			detail: "The server failed to answer the request.",
			count: 0,
		},
		{
			label: "Caller mistakes",
			codes: ["-32602", "-32601"],
			detail: "Bad params or an unknown method: not counted as failures.",
			count: 0,
		},
	],
	methods: [
		{ method: "tools/call", calls: 387, p50: 124 * MS, p95: 600 * MS },
		{ method: "initialize", calls: 93, p50: 0, p95: 0 },
		{ method: "tools/list", calls: 78, p50: 0, p95: 0 },
		{ method: "prompts/list", calls: 70, p50: 0, p95: 0 },
		{ method: "resources/list", calls: 70, p50: 0, p95: 0 },
	],
	coverage: [
		{
			isPresent: true,
			label: "Method and tool",
			attributes: ["mcp.method.name", "gen_ai.tool.name"],
			detail: "On every server span.",
		},
		{
			isPresent: true,
			label: "Tool failures",
			attributes: ["error.type"],
			detail: "7 tool errors in the window.",
		},
		{
			isPresent: true,
			label: "Client per call",
			attributes: ["user_agent.original"],
			detail: "On every call; clientInfo on initialize only.",
		},
		{
			isPresent: true,
			label: "Protocol",
			attributes: ["mcp.protocol.version", "network.transport"],
			detail: "2025-06-18 over tcp.",
		},
		{
			isPresent: false,
			label: "Sessions",
			attributes: ["mcp.session.id"],
			detail: "Not sent: the transport is stateless, so there is no sessions view.",
		},
		{
			isPresent: false,
			label: "Caller's trace",
			attributes: ["params._meta.traceparent"],
			detail: "0 of 387 calls join an agent's trace.",
		},
		{
			isPresent: false,
			label: "Why a tool failed",
			attributes: ["exception", "gen_ai.tool.call.result"],
			detail: "Tool errors carry no message, so failures can't be grouped by cause.",
		},
	],
}

export const MCP_SERVERS: ReadonlyArray<McpServerRow> = [
	{
		service: "maple-ai",
		protocolVersion: "2025-06-18",
		calls: 387,
		errors: 7,
		p95: 600 * MS,
		tools: 13,
		topClient: "curl",
		topClientShare: 272 / 387,
		lastCallMs: at(12, 31),
		spark: SERVER_SERIES.map((point) => point.calls),
	},
]

export const MCP_RUN_SQL: McpToolDetail = {
	tool: "run_sql",
	calls: 115,
	errors: 7,
	clients: 5,
	firstCallMs: at(9, 34),
	lastCallMs: at(12, 31),
	series: series({
		0: [2, 2, 187, 225, 239],
		8: [8, 0, 230, 330, 352],
		9: [22, 0, 190, 520, 740],
		10: [58, 3, 201, 610, 1140],
		11: [21, 2, 185, 880, 2410],
		12: [4, 0, 210, 640, 721],
	}),
	clientSeries: split({
		curl: { 9: 10, 10: 47, 11: 10 },
		"Node (undici)": { 8: 8, 9: 11 },
		Bun: { 11: 11, 12: 4 },
		"Claude Code": { 9: 1, 10: 11 },
		"preview-verifier": { 0: 2 },
	}),
	errorGroups: [
		{
			errorType: "tool_error",
			message: null,
			count: 7,
			clients: 4,
			lastSeenMs: at(12, 26, 56),
			trend: sparkOf({ 0: 2, 10: 3, 11: 2 }),
		},
	],
	slowest: [
		{
			timeMs: at(12, 26, 2),
			client: "Bun",
			requestId: "1",
			durationNs: 10_823 * MS,
			errorType: "tool_error",
			traceId: "a660d8ed",
		},
		{
			timeMs: at(12, 26, 17),
			client: "Bun",
			requestId: "1",
			durationNs: 2411 * MS,
			errorType: null,
			traceId: "684105b7",
		},
		{
			timeMs: at(12, 2, 35),
			client: "curl",
			requestId: "1",
			durationNs: 1716 * MS,
			errorType: null,
			traceId: "8e97ee08",
		},
		{
			timeMs: at(12, 2, 41),
			client: "curl",
			requestId: "1",
			durationNs: 1423 * MS,
			errorType: null,
			traceId: "40412fff",
		},
		{
			timeMs: at(11, 51, 57),
			client: "Node (undici)",
			requestId: "7",
			durationNs: 1162 * MS,
			errorType: null,
			traceId: "b35b94c5",
		},
		{
			timeMs: at(12, 2, 31),
			client: "curl",
			requestId: "1",
			durationNs: 1149 * MS,
			errorType: null,
			traceId: "13375690",
		},
		{
			timeMs: at(12, 11, 48),
			client: "Claude Code",
			requestId: "9",
			durationNs: 1078 * MS,
			errorType: null,
			traceId: "ce464d25",
		},
	],
	failed: [
		call(at(12, 26, 56), "Bun", "2", 84, "tool_error", "5b1e07c2"),
		call(at(12, 26, 2), "Bun", "1", 10_823, "tool_error", "a660d8ed"),
		call(at(12, 11, 51), "Claude Code", "8", 35, "tool_error", "91d4af30"),
		call(at(12, 4, 4), "curl", "1", 151, "tool_error", "e2c86b19"),
		call(at(12, 3, 52), "curl", "1", 108, "tool_error", "37fa0d54"),
		call(at(9, 34, 10), "preview-verifier", "3", 225, "tool_error", "c0a9e6f1"),
		call(at(9, 34, 0), "preview-verifier", "2", 149, "tool_error", "6d2b8e47"),
	],
	recent: [
		call(at(12, 31, 20), "Bun", "4", 212, null, "f4a1c6d8"),
		call(at(12, 31, 12), "Bun", "3", 198, null, "0be57a92"),
		call(at(12, 30, 58), "Bun", "2", 721, null, "8c3d1e5f"),
		call(at(12, 30, 41), "Bun", "1", 236, null, "2a96f0b4"),
		call(at(12, 26, 56), "Bun", "2", 84, "tool_error", "5b1e07c2"),
		call(at(12, 26, 17), "Bun", "1", 2411, null, "684105b7"),
		call(at(12, 26, 2), "Bun", "1", 10_823, "tool_error", "a660d8ed"),
	],
}

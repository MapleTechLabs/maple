#!/usr/bin/env bun
/**
 * Seed MCP server spans with sessions into a Tinybird `traces` datasource, for `/mcp-servers`.
 *
 *   bun scripts/seed-mcp-sessions.ts --org <orgId> [--dry-run]
 *
 * `docs-mcp` follows the OpenTelemetry MCP conventions with `mcp.session.id`: a Claude Code session
 * whose calls carry the agent's trace in `params._meta` (so the agent's spans, stamped the way the
 * ingest gateway stamps them, make an Agent Session), a Cursor session with a JSON-RPC failure, a
 * Codex session with tool errors, and two curl calls without a session. `notes-mcp` answers tool
 * calls with no session id at all. Rows go to TINYBIRD_HOST with TINYBIRD_TOKEN (`.env.local`).
 */
import { parseArgs } from "node:util"

const { values } = parseArgs({
	options: { org: { type: "string" }, "dry-run": { type: "boolean", default: false } },
})
if (values.org === undefined) {
	console.error("Pass --org <orgId>")
	process.exit(2)
}
const org = values.org

let seed = 7
const random = () => {
	seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
	return seed / 2 ** 31
}
const hex = (length: number) => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("")
const timeOf = (ms: number) => `${new Date(ms).toISOString().slice(0, 23).replace("T", " ")}000000`

type Row = Record<string, unknown>
const rows: Row[] = []

const span = (options: {
	service: string
	name: string
	kind: "Server" | "Client" | "Internal"
	startMs: number
	durationMs: number
	traceId: string
	parentSpanId?: string
	attributes: Record<string, string>
	status?: "Ok" | "Error" | "Unset"
	message?: string
	link?: Readonly<{ traceId: string; spanId: string }>
}): string => {
	const spanId = hex(16)
	rows.push({
		start_time: timeOf(options.startMs),
		trace_id: options.traceId,
		span_id: spanId,
		parent_span_id: options.parentSpanId ?? "",
		trace_state: "",
		span_name: options.name,
		span_kind: options.kind,
		service_name: options.service,
		resource_schema_url: "",
		resource_attributes: {
			"service.name": options.service,
			"deployment.environment.name": "development",
			maple_org_id: org,
			maple_ingest_source: "seed-mcp-sessions",
		},
		scope_schema_url: "",
		scope_name: "seed-mcp-sessions",
		scope_version: "",
		scope_attributes: {},
		duration: Math.round(options.durationMs * 1_000_000),
		status_code: options.status ?? "Unset",
		status_message: options.message ?? "",
		span_attributes: options.attributes,
		events_timestamp: [],
		events_name: [],
		events_attributes: [],
		links_trace_id: options.link === undefined ? [] : [options.link.traceId],
		links_span_id: options.link === undefined ? [] : [options.link.spanId],
		links_trace_state: options.link === undefined ? [] : [""],
		links_attributes: options.link === undefined ? [] : [{}],
	})
	return spanId
}

type Request = Readonly<{
	method: string
	tool?: string
	durationMs: number
	errorType?: string
	message?: string
	/** The caller's trace and span from `params._meta`: the span's parent. */
	caller?: Readonly<{ traceId: string; spanId: string }>
}>

/** One request as a spec-following server records it: an HTTP span, and the MCP span under it or under the caller. */
const request = (
	server: string,
	options: Readonly<{ sessionId?: string; userAgent: string; startMs: number; id: number }>,
	req: Request,
) => {
	const httpTrace = hex(32)
	const httpSpan = span({
		service: server,
		name: "POST /mcp",
		kind: "Server",
		startMs: options.startMs,
		durationMs: req.durationMs + 2,
		traceId: httpTrace,
		attributes: { "http.request.method": "POST", "user_agent.original": options.userAgent },
	})
	const isJsonRpcError = req.errorType !== undefined && req.errorType !== "tool_error"
	// Only the attributes the request has; an absent one is left off, as a server would.
	const attributes = Object.fromEntries(
		[
			["mcp.method.name", req.method],
			["mcp.protocol.version", "2025-06-18"],
			["jsonrpc.request.id", String(options.id)],
			["network.transport", "tcp"],
			["user_agent.original", options.userAgent],
			["mcp.session.id", options.sessionId],
			["gen_ai.tool.name", req.tool],
			["gen_ai.operation.name", req.tool === undefined ? undefined : "execute_tool"],
			["error.type", req.errorType],
			["rpc.response.status_code", isJsonRpcError ? req.errorType : undefined],
		].filter((entry): entry is [string, string] => entry[1] !== undefined),
	)
	span({
		service: server,
		name: req.tool === undefined ? req.method : `${req.method} ${req.tool}`,
		kind: "Server",
		startMs: options.startMs + 1,
		durationMs: req.durationMs,
		traceId: req.caller?.traceId ?? httpTrace,
		parentSpanId: req.caller?.spanId ?? httpSpan,
		link: req.caller === undefined ? undefined : { traceId: httpTrace, spanId: httpSpan },
		status: isJsonRpcError ? "Error" : "Unset",
		message: req.message,
		attributes,
	})
}

const session = (
	server: string,
	options: Readonly<{ sessionId?: string; userAgent: string; startMs: number; gapMs: number }>,
	requests: ReadonlyArray<Request>,
) =>
	requests.forEach((req, index) =>
		request(server, { ...options, startMs: options.startMs + index * options.gapMs, id: index + 1 }, req),
	)

const now = Date.now()
const MIN = 60_000

// Claude Code, propagating its trace: one agent turn per tool call, stamped as the gateway stamps them.
const claudeSession = "claude-code-7c1e44a0"
const agentCalls: ReadonlyArray<Request> = [
	{ method: "initialize", durationMs: 12 },
	{ method: "tools/list", durationMs: 9 },
	{ method: "tools/call", tool: "search_docs", durationMs: 184 },
	{ method: "tools/call", tool: "get_page", durationMs: 92 },
	{ method: "tools/call", tool: "search_docs", durationMs: 221 },
	{
		method: "tools/call",
		tool: "get_page",
		durationMs: 38,
		errorType: "tool_error",
		message: "Page /guides/otel-collector not found",
	},
	{ method: "tools/call", tool: "get_page", durationMs: 87 },
	{ method: "tools/call", tool: "list_sections", durationMs: 54 },
]
const claudeStart = now - 95 * MIN
const claudeRequests = agentCalls.map((req, index) => {
	if (req.method !== "tools/call") return req
	const traceId = hex(32)
	const startMs = claudeStart + index * 40_000 - 1_500
	const turn = span({
		service: "claude-code",
		name: "claude_code.interaction",
		kind: "Internal",
		startMs,
		durationMs: req.durationMs + 1_400,
		traceId,
		attributes: {
			"maple_ai.vendor.id": "claude_code",
			"maple_ai.session.id": claudeSession,
			"maple_ai.llm_call": "1",
			"maple_ai.model": "claude-opus-5-5",
		},
	})
	const tool = span({
		service: "claude-code",
		name: `claude_code.tool ${req.tool ?? ""}`,
		kind: "Client",
		startMs: startMs + 1_000,
		durationMs: req.durationMs + 20,
		traceId,
		parentSpanId: turn,
		status: req.errorType === undefined ? "Unset" : "Error",
		attributes: {
			"maple_ai.vendor.id": "claude_code",
			"maple_ai.tool_call": "1",
			"maple_ai.tool.name": `mcp__docs__${req.tool ?? ""}`,
			"maple_ai.error": req.errorType === undefined ? "0" : "1",
		},
	})
	return { ...req, caller: { traceId, spanId: tool } }
})
session(
	"docs-mcp",
	{
		sessionId: "3f6c1d2a-8b4e-4f7a-9c21-5d0e7b9a4c11",
		userAgent: "claude-code/2.1.314 (cli)",
		startMs: claudeStart,
		gapMs: 40_000,
	},
	claudeRequests,
)

// Cursor, no trace context: its calls belong to no Agent Session. One server failure.
session(
	"docs-mcp",
	{
		sessionId: "b81e2c90-1f3d-4a6b-8e57-2c4d9f0a7e33",
		userAgent: "cursor/1.7.2",
		startMs: now - 50 * MIN,
		gapMs: 25_000,
	},
	[
		{ method: "initialize", durationMs: 15 },
		{ method: "tools/call", tool: "search_docs", durationMs: 310 },
		{
			method: "tools/call",
			tool: "search_docs",
			durationMs: 1_840,
			errorType: "-32603",
			message: "upstream search timed out",
		},
		{ method: "tools/call", tool: "get_page", durationMs: 120 },
	],
)

// Codex, two tool errors in a row.
session(
	"docs-mcp",
	{
		sessionId: "e09a7b45-6c2f-4d18-a3b9-7f1e5c8d2a60",
		userAgent: "openai-mcp/1.0.0",
		startMs: now - 20 * MIN,
		gapMs: 12_000,
	},
	[
		{ method: "initialize", durationMs: 10 },
		{ method: "tools/list", durationMs: 8 },
		{
			method: "tools/call",
			tool: "get_page",
			durationMs: 31,
			errorType: "tool_error",
			message: "Page /api/v3 not found",
		},
		{
			method: "tools/call",
			tool: "get_page",
			durationMs: 29,
			errorType: "tool_error",
			message: "Page /api/v2 not found",
		},
		{ method: "tools/call", tool: "search_docs", durationMs: 205 },
	],
)

// curl, stateless: no session id, so these calls belong to no session.
session("docs-mcp", { userAgent: "curl/8.7.1", startMs: now - 10 * MIN, gapMs: 5_000 }, [
	{ method: "tools/call", tool: "search_docs", durationMs: 140 },
	{ method: "tools/call", tool: "list_sections", durationMs: 44 },
])

// A server that issues no sessions at all.
session("notes-mcp", { userAgent: "claude-code/2.1.314 (cli)", startMs: now - 30 * MIN, gapMs: 20_000 }, [
	{ method: "tools/call", tool: "create_note", durationMs: 66 },
	{ method: "tools/call", tool: "list_notes", durationMs: 23 },
])

console.log(`${rows.length} spans for ${org}`)
if (values["dry-run"]) {
	console.log(JSON.stringify(rows.slice(0, 2), null, 2))
	process.exit(0)
}

const host = process.env.TINYBIRD_HOST
const token = process.env.TINYBIRD_TOKEN
if (!host || !token) {
	console.error("TINYBIRD_HOST and TINYBIRD_TOKEN are required")
	process.exit(2)
}
const response = await fetch(`${host.replace(/\/+$/, "")}/v0/events?name=traces&wait=true`, {
	method: "POST",
	headers: { Authorization: `Bearer ${token}` },
	body: rows.map((row) => JSON.stringify(row)).join("\n"),
})
if (!response.ok) {
	console.error(`Tinybird answered ${response.status}: ${await response.text()}`)
	process.exit(1)
}
console.log("Seeded.", await response.text())

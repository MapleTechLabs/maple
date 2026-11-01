import type {
	McpOverviewResponse,
	McpSeriesPoint,
	McpServersResponse,
	McpToolResponse,
} from "@maple/domain/http"
import type { ToolSeriesPoint } from "../../agent-sessions/tools-kit/model"
import type { McpCoverageRow, McpFailureKind, McpServerOverview, McpServerRow, McpToolDetail } from "../data"

// The hub's reads in the shapes the MCP views draw. Counts arrive raw; the words are here.

type Overview = McpOverviewResponse
type Tool = McpToolResponse

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count.toLocaleString()} ${count === 1 ? one : many}`

const point = (row: McpSeriesPoint): ToolSeriesPoint => ({ ...row, sessions: 0 })

export const serverRows = (response: McpServersResponse): ReadonlyArray<McpServerRow> =>
	response.servers

/** The failure panel: tool errors, server-side JSON-RPC errors, and the caller mistakes the spec exempts. */
export const failureKinds = (failures: Overview["failures"]): ReadonlyArray<McpFailureKind> => {
	const toolErrors = failures.filter((row) => row.errorType === "tool_error")
	const rpc = failures.filter((row) => row.errorType !== "tool_error")
	return [
		{
			label: "Tool errors",
			codes: ["error.type = tool_error"],
			detail: "The tool answered with isError: true.",
			count: toolErrors.reduce((sum, row) => sum + row.count, 0),
		},
		{
			label: "JSON-RPC errors",
			codes: rpc.length === 0 ? ["-32603"] : rpc.map((row) => row.errorType),
			detail: "The server failed to answer the request.",
			count: rpc.reduce((sum, row) => sum + row.count, 0),
		},
		{
			label: "Caller mistakes",
			codes: ["-32602", "-32601"],
			detail: "Bad params or an unknown method: not counted as failures.",
			count: 0,
		},
	]
}

export const coverageRows = (coverage: Overview["coverage"]): ReadonlyArray<McpCoverageRow> => {
	const calls = coverage.toolCalls
	const every = (count: number, what: string) =>
		count === calls ? `On every ${what}.` : `On ${count.toLocaleString()} of ${plural(calls, what)}.`
	return [
		{
			isPresent: calls > 0 && coverage.withToolName === calls,
			label: "Method and tool",
			attributes: ["mcp.method.name", "gen_ai.tool.name"],
			detail: every(coverage.withToolName, "tool call"),
		},
		{
			isPresent: coverage.toolErrors > 0,
			label: "Tool failures",
			attributes: ["error.type"],
			detail:
				coverage.toolErrors === 0
					? "No failed calls in the window, so this can't be checked yet."
					: `${plural(coverage.toolErrors, "failed call")} in the window.`,
		},
		{
			isPresent: calls > 0 && coverage.withUserAgent === calls,
			label: "Client per call",
			attributes: ["user_agent.original"],
			detail: `${every(coverage.withUserAgent, "tool call")} clientInfo rides on initialize only.`,
		},
		{
			isPresent: coverage.protocolVersion !== "",
			label: "Protocol",
			attributes: ["mcp.protocol.version", "network.transport"],
			detail:
				coverage.protocolVersion === ""
					? "Not sent."
					: `${coverage.protocolVersion}${coverage.transport === "" ? "" : ` over ${coverage.transport}`}.`,
		},
		{
			isPresent: coverage.withSession > 0,
			label: "Sessions",
			attributes: ["mcp.session.id"],
			detail:
				coverage.withSession > 0
					? every(coverage.withSession, "tool call")
					: "Not sent: without a session id there is no sessions view.",
		},
		{
			isPresent: coverage.withCallerTrace > 0,
			label: "Caller's trace",
			attributes: ["params._meta.traceparent"],
			detail: `${coverage.withCallerTrace.toLocaleString()} of ${plural(calls, "call")} join an agent's trace.`,
		},
		{
			isPresent: coverage.errorsWithMessage > 0,
			label: "Why a tool failed",
			attributes: ["exception", "gen_ai.tool.call.result"],
			detail:
				coverage.errorsWithMessage > 0
					? `${coverage.errorsWithMessage.toLocaleString()} of ${plural(coverage.toolErrors, "failed call")} say why.`
					: "Tool errors carry no message, so failures can't be grouped by cause.",
		},
	]
}

export const overviewOf = (response: Overview, nowMs: number): McpServerOverview => ({
	service: response.service,
	protocolVersion: response.protocolVersion,
	transport: response.transport === "tcp" ? "HTTP" : response.transport,
	firstSpanMs: response.firstSpanMs,
	nowMs,
	series: response.series.map(point),
	clientSeries: response.clientSeries.map(point),
	totals: response.totals,
	tools: response.tools,
	clients: response.clients,
	initializers: response.initializers,
	failures: failureKinds(response.failures),
	methods: response.methods,
	coverage: coverageRows(response.coverage),
})

export const toolOf = (response: Tool): McpToolDetail => ({
	tool: response.tool,
	calls: response.calls,
	errors: response.errors,
	clients: response.clients,
	firstCallMs: response.firstCallMs,
	lastCallMs: response.lastCallMs,
	series: response.series.map(point),
	clientSeries: response.clientSeries.map(point),
	errorGroups: response.errorGroups,
	slowest: response.slowest,
	failed: response.failed,
	recent: response.recent,
})

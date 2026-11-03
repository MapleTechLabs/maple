import type { ToolSeriesPoint } from "../page/agent-sessions/tools-kit/model"
import type { McpCallRow, McpServerOverview, McpToolDetail, McpToolRow } from "../page/mcp/data"
import type { McpFilters } from "../page/mcp/view-kit"
import { MCP_CLIENT_TOOLS, MCP_OVERVIEW, MCP_RUN_SQL } from "./mcp-fixture"
import { Array as Arr, String as Str } from "effect"

// The fixture narrowed the way the reads would be. Calls and errors come from the per-(client, tool)
// breakdown and the per-client series; durations have no per-client split, so they stay server-wide.

const sum = <A>(rows: ReadonlyArray<A>, read: (row: A) => number): number =>
	Arr.reduce(rows, 0, (total, row) => total + read(row))

/** The merged series rebuilt from the kept clients' series; percentiles stay the server's. */
const seriesOf = (
	merged: ReadonlyArray<ToolSeriesPoint>,
	byClient: ReadonlyArray<ToolSeriesPoint>,
): ReadonlyArray<ToolSeriesPoint> =>
	Arr.map(merged, (point) => {
		const inBucket = Arr.filter(byClient, (entry) => entry.bucket === point.bucket)
		return {
			...point,
			calls: sum(inBucket, (entry) => entry.calls),
			errors: sum(inBucket, (entry) => entry.errors),
		}
	})

/**
 * The merged series rebuilt from the kept tools, for a search or "failing only": each tool's spark
 * scaled to its narrowed calls (only `run_sql` fails, so its series carries the errors).
 */
const toolSeriesOf = (
	tools: ReadonlyArray<McpToolRow>,
	filters: McpFilters,
): ReadonlyArray<ToolSeriesPoint> => {
	const full = new Map(Arr.map(MCP_OVERVIEW.tools, (row) => [row.tool, row]))
	const runSql = Arr.some(tools, (row) => row.tool === MCP_RUN_SQL.tool) ? filteredTool(filters).series : []
	return Arr.map(MCP_OVERVIEW.series, (point, index) => ({
		...point,
		calls: Math.round(
			sum(tools, (row) => {
				const all = full.get(row.tool)
				return all === undefined || all.calls === 0
					? 0
					: ((all.spark[index] ?? 0) * row.calls) / all.calls
			}),
		),
		errors: runSql[index]?.errors ?? 0,
	}))
}

/** A client's kind, from the overview's client rows. */
const kindOf = (client: string) => MCP_OVERVIEW.clients.find((row) => row.name === client)?.kind

export const hasFilter = (filters: McpFilters): boolean =>
	filters.client !== undefined ||
	filters.kind !== undefined ||
	filters.isFailingOnly ||
	Str.trim(filters.search) !== ""

/** `/mcp/:service` under the toolbar's filters: clients, tools, totals and series all narrow. */
export const filteredOverview = (filters: McpFilters): McpServerOverview => {
	if (!hasFilter(filters)) return MCP_OVERVIEW
	const needle = Str.toLowerCase(Str.trim(filters.search))
	// The (client, tool) pairs every filter keeps; clients, tools and totals all come from them.
	const pairs = Arr.filter(
		MCP_CLIENT_TOOLS,
		(pair) =>
			(filters.client === undefined || pair.client === filters.client) &&
			(filters.kind === undefined || kindOf(pair.client) === filters.kind) &&
			Str.includes(needle)(Str.toLowerCase(pair.tool)) &&
			(!filters.isFailingOnly || pair.errors > 0),
	)
	const tools = Arr.flatMap(MCP_OVERVIEW.tools, (row) => {
		const mine = Arr.filter(pairs, (pair) => pair.tool === row.tool)
		const calls = sum(mine, (pair) => pair.calls)
		const errors = sum(mine, (pair) => pair.errors)
		return calls === 0
			? []
			: [
					{
						...row,
						calls,
						errors,
						topError: errors > 0 ? row.topError : null,
						spark: Arr.map(row.spark, (value) => Math.round((value * calls) / row.calls)),
					},
				]
	}).toSorted((a, b) => b.calls - a.calls)
	// A quiet client (connects, no tool call) stays under a client or kind filter, as the API keeps it.
	const keepsQuiet = needle === "" && !filters.isFailingOnly
	const clients = Arr.flatMap(MCP_OVERVIEW.clients, (client) => {
		if (client.calls === 0)
			return keepsQuiet &&
				(filters.client === undefined || client.name === filters.client) &&
				(filters.kind === undefined || client.kind === filters.kind)
				? [client]
				: []
		const mine = Arr.filter(pairs, (pair) => pair.client === client.name)
		const calls = sum(mine, (pair) => pair.calls)
		return calls === 0 ? [] : [{ ...client, calls, errors: sum(mine, (pair) => pair.errors) }]
	})
	// Each kept client's series scaled to the share of its calls the filters keep.
	const clientSeries = Arr.flatMap(MCP_OVERVIEW.clientSeries, (point) => {
		const full = MCP_OVERVIEW.clients.find((client) => client.name === point.seriesKey)
		const kept = clients.find((client) => client.name === point.seriesKey)
		if (full === undefined || kept === undefined) return []
		return [
			{
				...point,
				calls: Math.round((point.calls * kept.calls) / full.calls),
				errors: full.errors === 0 ? 0 : Math.round((point.errors * kept.errors) / full.errors),
			},
		]
	})
	const errors = sum(tools, (row) => row.errors)
	return {
		...MCP_OVERVIEW,
		series:
			filters.isFailingOnly || needle !== ""
				? toolSeriesOf(tools, filters)
				: seriesOf(MCP_OVERVIEW.series, clientSeries),
		clientSeries,
		totals: { ...MCP_OVERVIEW.totals, calls: sum(tools, (row) => row.calls), errors },
		tools,
		clients,
		failures: Arr.map(MCP_OVERVIEW.failures, (row) =>
			row.label === "Tool errors" ? { ...row, count: errors } : row,
		),
	}
}

/** `run_sql` under the client and failing filters: its calls, failures, series and call lists. */
export const filteredTool = (filters: McpFilters): McpToolDetail => {
	if (filters.client === undefined && filters.kind === undefined && !filters.isFailingOnly)
		return MCP_RUN_SQL
	const pairs = Arr.filter(
		MCP_CLIENT_TOOLS,
		(pair) =>
			pair.tool === MCP_RUN_SQL.tool &&
			(filters.client === undefined || pair.client === filters.client) &&
			(filters.kind === undefined || kindOf(pair.client) === filters.kind) &&
			(!filters.isFailingOnly || pair.errors > 0),
	)
	const names = new Set(Arr.map(pairs, (pair) => pair.client))
	const keep = (call: McpCallRow) =>
		names.has(call.client) && (!filters.isFailingOnly || call.errorType !== null)
	const clientSeries = Arr.filter(MCP_RUN_SQL.clientSeries, (point) => names.has(point.seriesKey))
	const errors = sum(pairs, (pair) => pair.errors)
	const failed = Arr.filter(MCP_RUN_SQL.failed, keep)
	const series = seriesOf(MCP_RUN_SQL.series, clientSeries)
	return {
		...MCP_RUN_SQL,
		calls: sum(pairs, (pair) => pair.calls),
		errors,
		clients: names.size,
		series,
		clientSeries,
		errorGroups:
			errors === 0
				? []
				: Arr.map(MCP_RUN_SQL.errorGroups, (group) => ({
						...group,
						count: errors,
						clients: Arr.filter(pairs, (pair) => pair.errors > 0).length,
						lastSeenMs: Math.max(...Arr.map(failed, (call) => call.timeMs), 0),
						trend: Arr.map(series, (point) => point.errors),
					})),
		slowest: Arr.filter(MCP_RUN_SQL.slowest, keep),
		failed,
		recent: Arr.filter(MCP_RUN_SQL.recent, keep),
	}
}

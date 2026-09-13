import type { McpToolRegistrar } from "./types"
import {
	agentToolSelection,
	agentToolSelectionParams,
	agentToolTextParam,
	agentToolWindowParams,
	compactTrend,
	describeSelection,
	formatNanos,
	formatSeen,
	orDash,
	pageCount,
	TREND_BUCKETS,
} from "../lib/agent-tool-analytics"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "../lib/time"
import { optionalText } from "../lib/limits"
import {
	formatDelta,
	formatNumber,
	formatPointsDelta,
	formatTable,
	percentOf,
	tableCell,
} from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import {
	readAiToolErrors,
	readAiToolsBreakdowns,
	readAiToolsTotals,
} from "@maple/backend/services/ai-sessions/ai-session-reads"
import {
	AiToolErrorsRequest,
	AiToolsBreakdownsRequest,
	AiToolsTotalsRequest,
	type AiToolsAggregate,
} from "@maple/domain/http"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"

/** Failure groups a selected tool reports. Past that the answer is a ledger,
 *  and the groups worth reading are the busiest ones. */
const ERROR_GROUPS_MAX = 25

/** The group's message in the table; the full text is in `get_agent_tool_error`. */
const MESSAGE_CHARS = 120

/** The selected tool's `gen_ai.tool.description`, as it is rendered: whatever
 *  the MCP server the agent connected to stamped on the call — prose, headings,
 *  instructions — so it is collapsed and clipped like any other captured text
 *  rather than printed into the answer verbatim. */
const DESCRIPTION_CHARS = 300

/**
 * The bucket a group's trend is cut into: the window over the grid, one short.
 * The grid aligns its start DOWN to the lattice, so an unaligned window spans a
 * bucket more than its width. A minute is the floor, or a narrow window would
 * bucket by seconds.
 */
const trendBucketSeconds = (startMs: number, endMs: number): number => {
	const windowSeconds = Math.max(1, Math.round((endMs - startMs) / 1000))
	return Math.min(windowSeconds, Math.max(60, Math.ceil(windowSeconds / (TREND_BUCKETS - 1))))
}

const GROUP_COLUMNS = [
	"Fingerprint",
	"Error type",
	"Message",
	"Calls",
	"Sessions",
	"Variants",
	"First",
	"Last",
	"Calls since",
	"Trend",
]

export function registerGetAgentToolsOverviewTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_tools_overview",
		'AI agent tool calls (the tools an LLM agent invokes during a session — not browser sessions and not Maple\'s own MCP tools): how much each tool is called, how often it fails, and how slow it is. Reports the window against the equal window before it, plus a per-tool breakdown. Selecting one `tool` also lists its failure groups by error fingerprint — what it fails with, how often, and whether it is still failing. The tool names it lists are the ones `get_agent_tool_error` takes, and the ones `list_agent_sessions tools="…"` filters by. Start here with no filters, then select the tool with the worst error rate. For these calls over time, chart them with `query_data` or `run_sql`.',
		Schema.Struct({
			...agentToolWindowParams,
			tool: agentToolTextParam("Only this tool (exact `gen_ai.tool.name`). Omit to compare every tool"),
			...agentToolSelectionParams,
		}),
		Effect.fn("McpTool.getAgentToolsOverview")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "get_agent_tools_overview")
			const startMs = parseWarehouseDateTime(st)
			const endMs = parseWarehouseDateTime(et)
			const tool = optionalText(params.tool)
			// Only a selected tool reports failure groups, so only it has a trend to
			// bucket — the two are resolved together.
			const selected =
				tool === undefined ? undefined : { tool, bucketSeconds: trendBucketSeconds(startMs, endMs) }
			const selection = agentToolSelection(params, tool)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, tool: tool ?? "all" })

			const scope = { startTime: st, endTime: et, ...selection }
			const [totals, breakdowns, errorGroups] = yield* Effect.all(
				[
					readAiToolsTotals(
						tenant,
						new AiToolsTotalsRequest({ ...scope, periods: ["current", "previous", "window"] }),
					),
					readAiToolsBreakdowns(tenant, new AiToolsBreakdownsRequest(scope)),
					// The groups are fingerprints of ONE tool's failures, and "every
					// tool's groups" is a list with no question behind it.
					selected === undefined
						? Effect.succeed(undefined)
						: readAiToolErrors(
								tenant,
								new AiToolErrorsRequest({
									...scope,
									tool: selected.tool,
									bucketSeconds: selected.bucketSeconds,
									limit: ERROR_GROUPS_MAX,
								}),
							).pipe(Effect.map((response) => response.data)),
				],
				{ concurrency: 3 },
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_tools_overview")))

			yield* Effect.annotateCurrentSpan({
				"result.rowCount": breakdowns.tools.length,
				...(errorGroups !== undefined && { "result.errorGroupCount": errorGroups.length }),
			})

			const current = totals.current
			// The comparison window is only a comparison where something ran in it:
			// every measure against a zeroed one reads as `+inf`, which is not a
			// change anyone can act on.
			const comparable = totals.previous?.calls === 0 ? undefined : totals.previous
			const lines: string[] = [
				`## Agent tool calls`,
				`Time range: ${st} — ${et}`,
				`Selection: ${describeSelection(selection)}`,
				...(totals.description === undefined
					? []
					: [`Description: ${tableCell(totals.description, DESCRIPTION_CHARS)}`]),
				`First call: ${formatSeen(totals.firstSeen)} · Last call: ${formatSeen(totals.lastSeen)}`,
				``,
			]

			// How much of the window's agent traffic this selection covers — the one
			// fact an empty answer still carries.
			const sessionShare =
				totals.allSessions === undefined
					? []
					: [
							``,
							`Sessions running these tool calls: ${formatNumber(current.sessions)} of ${formatNumber(totals.allSessions)} agent sessions in the window (${percentOf(current.sessions, totals.allSessions)}).`,
						]

			if (current.calls === 0) {
				lines.push(
					"No agent tool calls matched this selection in the window.",
					...sessionShare,
					formatNextSteps([
						`\`get_agent_tools_overview\` with no filters — see which tools ran at all`,
						`\`list_agent_sessions\` — check whether any agent sessions were recorded in this window`,
					]),
				)
				return { content: [{ type: "text" as const, text: lines.join("\n") }] }
			}

			// `previous` is a window of equal length ending where this one begins.
			const measure = (
				label: string,
				read: (aggregate: AiToolsAggregate) => number,
				render: (aggregate: AiToolsAggregate) => string,
				// A rate's change is points, not a percentage of a percentage.
				delta: (current: number, previous: number) => string = formatDelta,
			) => [
				label,
				render(current),
				comparable === undefined ? "—" : render(comparable),
				comparable === undefined ? "—" : delta(read(current), read(comparable)),
			]
			lines.push(
				formatTable(
					["Measure", "Current", "Previous", "Change"],
					[
						measure(
							"Calls",
							(a) => a.calls,
							(a) => formatNumber(a.calls),
						),
						measure(
							"Sessions",
							(a) => a.sessions,
							(a) => formatNumber(a.sessions),
						),
						measure(
							"Errors",
							(a) => a.errors,
							(a) => formatNumber(a.errors),
						),
						measure(
							"Error rate",
							(a) => a.errors / a.calls,
							(a) => percentOf(a.errors, a.calls),
							formatPointsDelta,
						),
						measure(
							"p50",
							(a) => a.p50,
							(a) => formatNanos(a.p50),
						),
						measure(
							"p90",
							(a) => a.p90,
							(a) => formatNanos(a.p90),
						),
						measure(
							"p95",
							(a) => a.p95,
							(a) => formatNanos(a.p95),
						),
					],
				),
				...sessionShare,
			)

			// The breakdown ignores a selected `tool` on purpose — it is how a
			// caller picks a different one.
			lines.push(
				``,
				`### Tools (busiest first, top ${breakdowns.tools.length}${selected === undefined ? "" : " — every tool in the window, not just the selected one"})`,
				formatTable(
					["Tool", "Calls", "Sessions", "Errors", "Err %", "p50", "p95", "First seen", "Last seen"],
					breakdowns.tools.map((item) => [
						tableCell(item.key === "" ? "(unnamed)" : item.key, 60),
						formatNumber(item.calls),
						formatNumber(item.sessions),
						formatNumber(item.errors),
						percentOf(item.errors, item.calls),
						formatNanos(item.p50),
						formatNanos(item.p95),
						formatSeen(item.firstSeen),
						formatSeen(item.lastSeen),
					]),
				),
			)

			// A selected tool's groups are already above: what is left is to open
			// one, which is where the sample payloads live.
			const groupSteps: string[] = []
			if (selected !== undefined && errorGroups !== undefined) {
				lines.push(
					``,
					`### Failure groups of ${tableCell(selected.tool)} (${pageCount(errorGroups, ERROR_GROUPS_MAX)})`,
				)
				if (errorGroups.length === 0) {
					lines.push(`No failed calls of \`${tableCell(selected.tool)}\` in this window.`)
				} else {
					lines.push(
						`Most failed calls first. Trend is failed calls per ${selected.bucketSeconds}s bucket, oldest first.`,
						formatTable(
							GROUP_COLUMNS,
							errorGroups.map((group) => [
								group.fingerprint,
								orDash(group.errorType, 40),
								orDash(group.message, MESSAGE_CHARS),
								formatNumber(group.calls),
								formatNumber(group.sessions),
								formatNumber(group.variants),
								formatSeen(group.firstSeen),
								formatSeen(group.lastSeen),
								formatNumber(group.callsSince),
								// A zero-width window spans no buckets, and a blank cell
								// reads as a missing measure rather than no trend.
								orDash(
									compactTrend(group.trend, {
										startMs,
										endMs,
										bucketSeconds: selected.bucketSeconds,
									}).join(","),
								),
							]),
						),
						"`Calls since` counts the calls of this tool — failed or not — that came after the group's latest failure: a high count means the group stopped.",
					)
					groupSteps.push(
						...errorGroups
							.slice(0, 3)
							.map(
								(group) =>
									`\`get_agent_tool_error tool=${JSON.stringify(selected.tool)} fingerprint="${group.fingerprint}"\` — sessions, message variants and sample payloads of ${group.errorType === "" ? "this group" : tableCell(group.errorType, 40)} (${formatNumber(group.calls)} calls)`,
							),
					)
				}
			}

			// The tool worth looking at next is the one failing most, not the
			// busiest — and a tool with no failures has nothing to open.
			const worst = breakdowns.tools
				.filter((item) => item.errors > 0)
				.sort((a, b) => b.errors / b.calls - a.errors / a.calls)[0]
			const busiest = breakdowns.tools[0]
			lines.push(
				formatNextSteps([
					...groupSteps,
					...(selected === undefined && worst !== undefined
						? [
								`\`get_agent_tools_overview tool=${JSON.stringify(worst.key)}\` — the failure groups of the worst error rate (${percentOf(worst.errors, worst.calls)})`,
							]
						: []),
					...(busiest === undefined
						? []
						: [
								`\`list_agent_sessions tools=${JSON.stringify(busiest.key)}\` — the sessions that ran the busiest tool`,
							]),
				]),
			)

			return { content: [{ type: "text" as const, text: lines.join("\n") }] }
		}),
	)
}

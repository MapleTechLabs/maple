import { Effect, Schema } from "effect"
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
import { GetAgentToolsOverviewOutput } from "@maple/domain/mcp-outputs"
import { parseWarehouseDateTime } from "@maple/query-engine"
import type { McpToolRegistrar } from "./types"
import {
	AGENT_TOOL_WINDOW,
	agentToolSelection,
	agentToolSelectionParams,
	agentToolTextParam,
	compactTrend,
	describeSelection,
	formatNanos,
	formatSeen,
	cellOrDash,
	pageCount,
	selectionArgs,
	selectionRequest,
	TREND_BUCKETS,
} from "../lib/agent-tool-analytics"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDelta, formatNumber, formatPointsDelta, percentOf, tableCell, truncate } from "../lib/format"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { doc, type DocBlock, type NextCall } from "../lib/tool-doc"

/** Failure groups a selected tool reports. Past that the answer is a ledger, and the groups
 *  worth reading are the busiest ones. */
const ERROR_GROUPS_MAX = 25

/** The group's message in the table; the full text is in `get_agent_tool_error`. */
const MESSAGE_CHARS = 120

/** The selected tool's `gen_ai.tool.description`, as it is rendered: whatever the MCP server
 *  the agent connected to stamped on the call, so it is collapsed and clipped like any other
 *  captured text rather than printed into the answer verbatim. */
const DESCRIPTION_CHARS = 300

/**
 * The bucket a group's trend is cut into: the window over the grid, one short. The grid aligns
 * its start DOWN to the lattice, so an unaligned window spans a bucket more than its width. A
 * minute is the floor, or a narrow window would bucket by seconds.
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
	server.define({
		name: "get_agent_tools_overview",
		description:
			"AI agent tool calls (the tools an LLM agent invokes during a session, not browser sessions and not Maple's own MCP tools): how much each tool is called, how often it fails, and how slow it is. Reports the window against the equal window before it, plus a per-tool breakdown. Selecting one `tool` also lists its failure groups by error fingerprint: what it fails with, how often, and whether it is still failing. The tool names it lists are the ones `get_agent_tool_error` takes, and the ones `list_agent_sessions tools=[…]` filters by. Start here with no filters, then select the tool with the worst error rate. For these calls over time, chart them with `query_data` or `run_sql`.",
		parameters: Schema.Struct({
			...AGENT_TOOL_WINDOW.fields,
			tool: agentToolTextParam("Only this tool (exact `gen_ai.tool.name`). Omit to compare every tool"),
			...agentToolSelectionParams,
		}),
		output: GetAgentToolsOverviewOutput,
		hints: { readOnly: true },
		phrases: ["Checking agent tool usage"],
		handler: Effect.fn("McpTool.getAgentToolsOverview")(function* (params) {
			const { st, et } = yield* AGENT_TOOL_WINDOW.resolve(params, "get_agent_tools_overview")
			const startMs = parseWarehouseDateTime(st)
			const endMs = parseWarehouseDateTime(et)
			const tool = params.tool
			// Only a selected tool reports failure groups, so only it has a trend to bucket.
			const selected =
				tool === undefined ? undefined : { tool, bucketSeconds: trendBucketSeconds(startMs, endMs) }
			const selection = agentToolSelection(params, tool)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, tool: tool ?? "all" })

			const scope = { startTime: st, endTime: et, ...selectionRequest(selection) }
			const [totals, breakdowns, errorGroups] = yield* Effect.all(
				[
					readAiToolsTotals(
						tenant,
						new AiToolsTotalsRequest({ ...scope, periods: ["current", "previous", "window"] }),
					),
					readAiToolsBreakdowns(tenant, new AiToolsBreakdownsRequest(scope)),
					// The groups are fingerprints of ONE tool's failures, and "every tool's groups" is a
					// list with no question behind it.
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

			return {
				timeRange: { start: st, end: et },
				selection,
				...(totals.description === undefined ? undefined : { description: totals.description }),
				firstSeen: totals.firstSeen,
				lastSeen: totals.lastSeen,
				current: totals.current,
				...(totals.previous === undefined ? undefined : { previous: totals.previous }),
				...(totals.allSessions === undefined ? undefined : { allSessions: totals.allSessions }),
				tools: breakdowns.tools,
				...(selected === undefined || errorGroups === undefined
					? undefined
					: {
							failureGroups: {
								tool: selected.tool,
								bucketSeconds: selected.bucketSeconds,
								cap: ERROR_GROUPS_MAX,
								groups: errorGroups.map((group) => ({
									...group,
									trend: compactTrend(group.trend, {
										startMs,
										endMs,
										bucketSeconds: selected.bucketSeconds,
									}),
								})),
							},
						}),
			}
		}),
		render: (output) => {
			const { current, selection, failureGroups } = output
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			// The comparison window is only a comparison where something ran in it: every measure
			// against a zeroed one reads as `+inf`, which is not a change anyone can act on.
			const comparable = output.previous?.calls === 0 ? undefined : output.previous
			const header: ReadonlyArray<DocBlock> = [
				doc.fields([
					["Selection", describeSelection(selection)],
					[
						"Description",
						output.description === undefined
							? undefined
							: tableCell(output.description, DESCRIPTION_CHARS),
					],
					["First call", formatSeen(output.firstSeen)],
					["Last call", formatSeen(output.lastSeen)],
				]),
			]
			// How much of the window's agent traffic this selection covers: the one fact an empty
			// answer still carries.
			const sessionShare =
				output.allSessions === undefined
					? []
					: [
							doc.text(
								`Sessions running these tool calls: ${formatNumber(current.sessions)} of ${formatNumber(output.allSessions)} agent sessions in the window (${percentOf(current.sessions, output.allSessions)}).`,
							),
						]
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
			]

			if (current.calls === 0) {
				return {
					title: "Agent tool calls",
					scope,
					empty: { message: "No agent tool calls matched this selection in the window." },
					blocks: [...header, ...sessionShare],
					next: [
						doc.next("get_agent_tools_overview", window, "see which tools ran at all"),
						doc.next(
							"list_agent_sessions",
							window,
							"check whether any agent sessions were recorded in this window",
						),
					],
				}
			}

			// `previous` is a window of equal length ending where this one begins.
			const measure = (
				label: string,
				read: (aggregate: AiToolsAggregate) => number,
				show: (aggregate: AiToolsAggregate) => string,
				// A rate's change is points, not a percentage of a percentage.
				delta: (current: number, previous: number) => string = formatDelta,
			) => [
				label,
				show(current),
				comparable === undefined ? "—" : show(comparable),
				comparable === undefined ? "—" : delta(read(current), read(comparable)),
			]

			const groupBlocks: ReadonlyArray<DocBlock> =
				failureGroups === undefined
					? []
					: [
							doc.heading(
								`Failure groups of ${tableCell(failureGroups.tool)} (${pageCount(failureGroups.groups, failureGroups.cap)})`,
							),
							failureGroups.groups.length === 0
								? doc.text(
										`No failed calls of \`${tableCell(failureGroups.tool)}\` in this window.`,
									)
								: doc.text(
										`Most failed calls first. Trend is failed calls per ${failureGroups.bucketSeconds}s bucket, oldest first.`,
									),
							...(failureGroups.groups.length === 0
								? []
								: [
										doc.table(
											GROUP_COLUMNS,
											failureGroups.groups.map((group) => [
												group.fingerprint,
												cellOrDash(group.errorType, 40),
												cellOrDash(group.message, MESSAGE_CHARS),
												formatNumber(group.calls),
												formatNumber(group.sessions),
												formatNumber(group.variants),
												formatSeen(group.firstSeen),
												formatSeen(group.lastSeen),
												formatNumber(group.callsSince),
												// A zero-width window spans no buckets, and a blank cell reads as a
												// missing measure rather than no trend.
												cellOrDash(group.trend.join(",")),
											]),
										),
										doc.text(
											"`Calls since` counts the calls of this tool, failed or not, that came after the group's latest failure: a high count means the group stopped.",
										),
									]),
						]

			// A selected tool's groups are already above: what is left is to open one, which is
			// where the sample payloads live.
			const groupSteps: ReadonlyArray<NextCall> =
				failureGroups === undefined
					? []
					: failureGroups.groups.slice(0, 3).map((group) =>
							doc.next(
								"get_agent_tool_error",
								{
									tool: failureGroups.tool,
									fingerprint: group.fingerprint,
									...window,
									...selectionArgs(selection),
								},
								`sessions, message variants and sample payloads of ${group.errorType === "" ? "this group" : truncate(group.errorType, 40)} (${formatNumber(group.calls)} calls)`,
							),
						)
			// The tool worth looking at next is the one failing most, not the busiest; a tool with
			// no failures has nothing to open.
			const worst = [...output.tools]
				.filter((item) => item.errors > 0)
				.sort((a, b) => b.errors / b.calls - a.errors / a.calls)[0]
			const busiest = output.tools[0]

			return {
				title: "Agent tool calls",
				scope,
				blocks: [
					...header,
					doc.table(
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
					// The breakdown ignores a selected `tool` on purpose: it is how a caller picks another.
					doc.heading(
						`Tools (busiest first, top ${output.tools.length}${failureGroups === undefined ? "" : ", every tool in the window, not just the selected one"})`,
					),
					doc.table(
						[
							"Tool",
							"Calls",
							"Sessions",
							"Errors",
							"Err %",
							"p50",
							"p95",
							"First seen",
							"Last seen",
						],
						output.tools.map((item) => [
							truncate(item.key === "" ? "(unnamed)" : item.key, 60),
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
					...groupBlocks,
				],
				next: [
					...groupSteps,
					...(failureGroups === undefined && worst !== undefined
						? [
								doc.next(
									"get_agent_tools_overview",
									{ ...window, tool: worst.key, ...selectionArgs(selection) },
									`the failure groups of the worst error rate (${percentOf(worst.errors, worst.calls)})`,
								),
							]
						: []),
					...(busiest === undefined
						? []
						: [
								doc.next(
									"list_agent_sessions",
									{ ...window, tools: [busiest.key] },
									"the sessions that ran the busiest tool",
								),
							]),
				],
			}
		},
	})
}

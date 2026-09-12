import { optionalNumberParam, optionalStringParam, validationError, type McpToolRegistrar } from "./types"
import {
	agentToolSelection,
	agentToolSelectionData,
	agentToolSelectionParams,
	agentToolWindowParams,
	describeSelection,
	formatDelta,
	formatNanos,
	formatRate,
	formatSeen,
	parseBucketSeconds,
	selectionValue,
} from "@/mcp/lib/agent-tool-analytics"
import type { AgentToolAggregateData } from "@maple/domain"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "@/mcp/lib/time"
import { formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import {
	readAiToolsBreakdowns,
	readAiToolsSeries,
	readAiToolsTotals,
} from "@/services/ai-sessions/ai-session-reads"
import {
	AiToolsBreakdownsRequest,
	AiToolsSeriesRequest,
	AiToolsSeriesKind,
	AiToolsTotalsRequest,
	type AiToolsAggregate,
} from "@maple/domain/http"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Option, Schema } from "effect"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

/** Points the series renders before it says it cut the rest. */
const SERIES_POINTS_MAX = 200

/** Percentiles are nanoseconds on the wire; everything below is milliseconds. */
const aggregateData = (aggregate: AiToolsAggregate): AgentToolAggregateData => ({
	calls: aggregate.calls,
	sessions: aggregate.sessions,
	errors: aggregate.errors,
	p50Ms: aggregate.p50 / 1_000_000,
	p90Ms: aggregate.p90 / 1_000_000,
	p95Ms: aggregate.p95 / 1_000_000,
})

export function registerGetAgentToolsOverviewTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_tools_overview",
		'AI agent tool calls (the tools an LLM agent invokes during a session — not browser sessions and not Maple\'s own MCP tools): how much each tool is called, how often it fails, and how slow it is. Reports the window against the equal window before it, plus a per-tool breakdown; pass bucket_seconds for a time series. The tool names it lists are the ones `list_agent_tool_errors` and `get_agent_tool_error` take, and the ones `list_agent_sessions tools="…"` filters by. Start here, then call `list_agent_tool_errors` for the tool with the worst error rate.',
		Schema.Struct({
			...agentToolWindowParams,
			tool: optionalStringParam(
				"Only this tool (exact `gen_ai.tool.name`). Omit to compare every tool",
			),
			...agentToolSelectionParams,
			bucket_seconds: optionalNumberParam(
				"Include a time series with this bucket width, in whole seconds (e.g. 3600 for hourly). Omitted: no series",
			),
			// Published as an enum, so a client reads the three values off the
			// schema and a fourth is a parameter error the decoder writes.
			split: Schema.optional(AiToolsSeriesKind).annotate({
				description:
					"Series split: tool | model | none. Default: tools, or the models a selected tool ran under",
			}),
		}),
		Effect.fn("McpTool.getAgentToolsOverview")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "get_agent_tools_overview")
			const windowSeconds = Math.max(
				1,
				Math.round((parseWarehouseDateTime(et) - parseWarehouseDateTime(st)) / 1000),
			)
			const requested =
				params.bucket_seconds === undefined
					? Option.none()
					: parseBucketSeconds(params.bucket_seconds, windowSeconds)
			if (params.bucket_seconds !== undefined && Option.isNone(requested)) {
				return validationError(
					`Invalid bucket_seconds: ${params.bucket_seconds}. Must be a whole number of seconds between 1 and ${windowSeconds} (the window's own width).`,
					`get_agent_tools_overview bucket_seconds=3600`,
				)
			}
			const bucketSeconds = Option.getOrUndefined(requested)
			const tool = selectionValue(params.tool)
			const selection = { ...agentToolSelection(params), tool }
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				tool: tool ?? "all",
				...(bucketSeconds !== undefined && { bucketSeconds }),
			})

			const [totals, breakdowns, seriesResult] = yield* Effect.all(
				[
					readAiToolsTotals(
						tenant,
						new AiToolsTotalsRequest({
							startTime: st,
							endTime: et,
							periods: ["current", "previous", "window"],
							...selection,
						}),
					),
					readAiToolsBreakdowns(
						tenant,
						new AiToolsBreakdownsRequest({ startTime: st, endTime: et, ...selection }),
					),
					bucketSeconds === undefined
						? Effect.succeedNone
						: readAiToolsSeries(
								tenant,
								new AiToolsSeriesRequest({
									startTime: st,
									endTime: et,
									bucketSeconds,
									...(params.split !== undefined && { split: params.split }),
									...selection,
								}),
							).pipe(Effect.map(Option.some)),
				],
				{ concurrency: 3 },
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_tools_overview")))

			const series = Option.getOrUndefined(seriesResult)
			// The series cut belongs on the span too — it is the reason a caller's
			// chart ends early, and the rendered note is not queryable.
			yield* Effect.annotateCurrentSpan({
				"result.rowCount": breakdowns.tools.length,
				...(series !== undefined && {
					"maple.ai.tools.series_points": Math.min(series.data.length, SERIES_POINTS_MAX),
					"maple.ai.tools.series_truncated": series.data.length > SERIES_POINTS_MAX,
				}),
			})
			const current = totals.current
			const previous = totals.previous
			const lines: string[] = [
				`## Agent tool calls`,
				`Time range: ${st} — ${et}`,
				`Selection: ${describeSelection(tool, params)}`,
			]
			if (totals.description !== undefined) lines.push(`Description: ${totals.description}`)
			lines.push(
				`First call: ${formatSeen(totals.firstSeen)} · Last call: ${formatSeen(totals.lastSeen)}`,
				``,
			)

			if (current.calls === 0) {
				lines.push(
					"No agent tool calls matched this selection in the window.",
					formatNextSteps([
						`\`get_agent_tools_overview\` with no filters — see which tools ran at all`,
						`\`get_agent_sessions_overview\` — check whether any agent sessions were recorded in this window`,
					]),
				)
				return {
					content: createDualContent(lines.join("\n"), {
						tool: "get_agent_tools_overview",
						data: {
							timeRange: { start: st, end: et },
							selection: agentToolSelectionData(tool, params),
							current: aggregateData(current),
							...(previous !== undefined && { previous: aggregateData(previous) }),
							...(totals.allSessions !== undefined && { allSessions: totals.allSessions }),
							...(totals.description !== undefined && { description: totals.description }),
							firstSeen: totals.firstSeen,
							lastSeen: totals.lastSeen,
							breakdown: [],
						},
					}),
				}
			}

			// `previous` is a window of equal length ending where this one begins;
			// zeros there mean nothing ran, which `formatDelta` reports as no
			// comparison rather than a -100%.
			const measure = (
				label: string,
				read: (aggregate: AiToolsAggregate) => number,
				format: (value: number) => string,
			) => [
				label,
				format(read(current)),
				previous === undefined ? "—" : format(read(previous)),
				previous === undefined ? "—" : formatDelta(read(current), read(previous)),
			]
			const errorRate = (aggregate: AiToolsAggregate) =>
				aggregate.calls === 0 ? 0 : aggregate.errors / aggregate.calls
			lines.push(
				formatTable(
					["Measure", "Current", "Previous", "Change"],
					[
						measure("Calls", (a) => a.calls, formatNumber),
						measure("Sessions", (a) => a.sessions, formatNumber),
						measure("Errors", (a) => a.errors, formatNumber),
						measure("Error rate", errorRate, (value) => `${(value * 100).toFixed(2)}%`),
						measure("p50", (a) => a.p50, formatNanos),
						measure("p90", (a) => a.p90, formatNanos),
						measure("p95", (a) => a.p95, formatNanos),
					],
				),
			)
			if (totals.allSessions !== undefined) {
				lines.push(
					``,
					`Sessions running these tool calls: ${formatNumber(current.sessions)} of ${formatNumber(totals.allSessions)} agent sessions in the window (${formatRate(current.sessions, totals.allSessions)}).`,
				)
			}

			// The breakdown ignores a selected `tool` on purpose — it is how a
			// caller picks a different one.
			lines.push(``, `### Tools (busiest first, top ${breakdowns.tools.length})`)
			lines.push(
				formatTable(
					["Tool", "Calls", "Sessions", "Errors", "Err %", "p50", "p95", "First seen", "Last seen"],
					breakdowns.tools.map((item) => [
						truncate(item.key === "" ? "(unnamed)" : item.key, 60),
						formatNumber(item.calls),
						formatNumber(item.sessions),
						formatNumber(item.errors),
						formatRate(item.errors, item.calls),
						formatNanos(item.p50),
						formatNanos(item.p95),
						formatSeen(item.firstSeen),
						formatSeen(item.lastSeen),
					]),
				),
			)

			// The query orders buckets oldest-first, so the cap keeps the newest
			// points: an agent asking about tool health wants the end of the window.
			const points = series === undefined ? [] : series.data.slice(-SERIES_POINTS_MAX)
			if (series !== undefined) {
				lines.push(
					``,
					`### Series (${bucketSeconds}s buckets, split by ${series.seriesKind})`,
					formatTable(
						["Bucket", "Key", "Calls", "Errors", "p95"],
						points.map((point) => [
							formatSeen(point.bucket),
							point.seriesKey === "" ? "(all)" : truncate(point.seriesKey, 40),
							formatNumber(point.calls),
							formatNumber(point.errors),
							formatNanos(point.p95),
						]),
					),
				)
				if (series.data.length > points.length) {
					lines.push(
						`Showing the newest ${points.length} of ${series.data.length} points — raise bucket_seconds or narrow the window.`,
					)
				}
			}

			// The tool worth looking at next is the one failing most, not the
			// busiest — and a tool with no failures has nothing to open.
			const worst = [...breakdowns.tools]
				.filter((item) => item.errors > 0)
				.sort((a, b) => b.errors / b.calls - a.errors / a.calls)[0]
			const busiest = breakdowns.tools[0]
			lines.push(
				formatNextSteps([
					...(worst === undefined
						? []
						: [
								`\`list_agent_tool_errors tool="${worst.key}"\` — the failure groups of the worst error rate (${formatRate(worst.errors, worst.calls)})`,
							]),
					...(busiest === undefined
						? []
						: [
								`\`list_agent_sessions tools="${busiest.key}"\` — the sessions that ran the busiest tool`,
							]),
					`\`get_agent_tools_overview tool="<tool>" bucket_seconds=3600\` — one tool over time, split by the models it ran under`,
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_agent_tools_overview",
					data: {
						timeRange: { start: st, end: et },
						selection: agentToolSelectionData(tool, params),
						current: aggregateData(current),
						...(previous !== undefined && { previous: aggregateData(previous) }),
						...(totals.allSessions !== undefined && { allSessions: totals.allSessions }),
						firstSeen: totals.firstSeen,
						lastSeen: totals.lastSeen,
						...(totals.description !== undefined && { description: totals.description }),
						breakdown: breakdowns.tools.map((item) => ({
							tool: item.key,
							calls: item.calls,
							sessions: item.sessions,
							errors: item.errors,
							p50Ms: item.p50 / 1_000_000,
							p95Ms: item.p95 / 1_000_000,
							firstSeen: item.firstSeen,
							lastSeen: item.lastSeen,
						})),
						...(series !== undefined &&
							bucketSeconds !== undefined && {
								series: {
									seriesKind: series.seriesKind,
									bucketSeconds,
									truncated: series.data.length > points.length,
									points: points.map((point) => ({
										bucket: point.bucket,
										seriesKey: point.seriesKey,
										calls: point.calls,
										errors: point.errors,
										p95Ms: point.p95 / 1_000_000,
									})),
								},
							}),
					},
				}),
			}
		}),
	)
}

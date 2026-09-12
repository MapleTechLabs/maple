import { optionalTimeParam, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "@/mcp/lib/time"
import { formatDurationFromMs, formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import { Effect, Schema } from "effect"
import {
	ListAiSessionsDistributionsRequest,
	ListAiSessionsFacetsRequest,
	type AiSessionDistribution,
} from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { readAiSessionDistributions, readAiSessionFacets } from "@/services/ai-sessions/ai-session-reads"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

/** Facet rows per dimension. Enough to pick a filter from, short enough to read. */
const FACET_ROWS = 10

/** Histogram buckets per measure — the shape of the spread, not the whole curve. */
const HISTOGRAM_BUCKETS = 12

type FacetItem = { readonly name: string; readonly count: number }

const facetTable = (title: string, items: readonly FacetItem[]): string[] => {
	if (items.length === 0) return []
	const shown = items.slice(0, FACET_ROWS)
	const more = items.length - shown.length
	return [
		``,
		`### ${title} (${items.length})${more > 0 ? ` — top ${shown.length}` : ""}`,
		formatTable(
			["Name", "Sessions"],
			shown.map((item) => [truncate(item.name || "(none)", 60), formatNumber(item.count)]),
		),
	]
}

export function registerGetAgentSessionsOverviewTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_sessions_overview",
		"What AI agent sessions (LLM agent traces, not browser session replays) are running in a window and how they spread: distinct sessions per vendor, service, environment, model, agent and tool, plus p50/p95 and a histogram for duration, cost, tokens, model calls and tool calls. Use it before `list_agent_sessions` to pick filters and sensible range bounds. The facets are deliberately unfiltered — they describe the whole window.",
		Schema.Struct({
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss UTC, default: 24h ago)"),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss UTC, default: now)"),
		}),
		Effect.fn("McpTool.getAgentSessionsOverview")(function* ({ start_time, end_time }) {
			const range = resolveTimeRange(start_time, end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "get_agent_sessions_overview")

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })

			// Two independent scans of the same window; the page runs them side by
			// side for the same reason.
			const [facets, distributions] = yield* Effect.all(
				[
					readAiSessionFacets(
						tenant,
						new ListAiSessionsFacetsRequest({ startTime: st, endTime: et }),
					),
					readAiSessionDistributions(
						tenant,
						new ListAiSessionsDistributionsRequest({ startTime: st, endTime: et }),
					),
				],
				{ concurrency: 2 },
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_sessions_overview")))

			yield* Effect.annotateCurrentSpan({
				"result.vendorCount": facets.vendors.length,
				"result.toolCount": facets.tools.length,
				"result.agentCount": facets.agents.length,
			})
			if (facets.vendors.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No AI agent sessions in ${st} — ${et}. Agent sessions are traces carrying gen_ai/maple_ai attributes; for browser session replays use \`search_sessions\`.`,
						},
					],
				}
			}

			const measures = [
				{ key: "durationMs" as const, label: "Duration", format: formatDurationFromMs },
				{ key: "cost" as const, label: "Cost", format: formatCost },
				{ key: "totalTokens" as const, label: "Tokens", format: formatNumber },
				{ key: "llmCalls" as const, label: "LLM calls", format: formatNumber },
				{ key: "toolCalls" as const, label: "Tool calls", format: formatNumber },
			]
			const histogram = (distribution: AiSessionDistribution, format: (value: number) => string) =>
				distribution.buckets
					.slice(0, HISTOGRAM_BUCKETS)
					.map((bucket) => `${format(bucket.floor)}×${bucket.count}`)
					.join("  ")

			const lines: string[] = [
				`## AI agent sessions overview`,
				`Time range: ${st} — ${et}`,
				`Counts are distinct sessions. Each facet counts the whole window, so picking one filter never hides the others.`,
				...facetTable("Vendors", facets.vendors),
				...facetTable("Services", facets.services),
				...facetTable("Environments", facets.environments),
				...facetTable("Models", facets.models),
				...facetTable("Agents", facets.agents),
				...facetTable("Tools", facets.tools),
				``,
				`### Distribution over sessions`,
				`Buckets are log-spaced, printed as \`floor×sessions\`; sessions whose measure is zero are not counted.`,
				formatTable(
					["Measure", "p50", "p95", "Spread"],
					measures.map(({ key, label, format }) => {
						const distribution = distributions[key]
						return [
							label,
							format(distribution.p50),
							format(distribution.p95),
							histogram(distribution, format) || "—",
						]
					}),
				),
			]

			const busiestAgent = facets.agents[0]
			const busiestTool = facets.tools[0]
			const nextSteps = [
				busiestAgent !== undefined
					? `\`list_agent_sessions agents="${busiestAgent.name}"\` — the sessions behind the busiest agent`
					: `\`list_agent_sessions\` — the window's sessions, newest first`,
				`\`list_agent_sessions has_errors=true sort_by="errorSpanCount"\` — the sessions that failed`,
				busiestTool !== undefined
					? `\`get_agent_tools_overview tool="${busiestTool.name}"\` — how that tool behaves across sessions`
					: `\`get_agent_tools_overview\` — tool call volume, latency and error rate`,
			]
			lines.push(formatNextSteps(nextSteps))

			const facetData = (items: readonly FacetItem[]) =>
				items.map((item) => ({ name: item.name, count: item.count }))
			const distributionData = (distribution: AiSessionDistribution) => ({
				p50: distribution.p50,
				p95: distribution.p95,
				buckets: distribution.buckets.map((bucket) => ({ floor: bucket.floor, count: bucket.count })),
			})

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_agent_sessions_overview",
					data: {
						timeRange: { start: st, end: et },
						facets: {
							vendors: facetData(facets.vendors),
							services: facetData(facets.services),
							environments: facetData(facets.environments),
							models: facetData(facets.models),
							agents: facetData(facets.agents),
							tools: facetData(facets.tools),
						},
						distributions: {
							durationMs: distributionData(distributions.durationMs),
							cost: distributionData(distributions.cost),
							totalTokens: distributionData(distributions.totalTokens),
							llmCalls: distributionData(distributions.llmCalls),
							toolCalls: distributionData(distributions.toolCalls),
						},
					},
				}),
			}
		}),
	)
}

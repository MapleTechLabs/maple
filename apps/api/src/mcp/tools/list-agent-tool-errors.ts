import { optionalNumberParam, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import {
	agentToolReadHandlers,
	agentToolSelection,
	agentToolSelectionData,
	agentToolSelectionParams,
	agentToolWindowParams,
	compactTrend,
	describeSelection,
	formatSeen,
} from "@/mcp/lib/agent-tool-analytics"
import { agentToolsContent } from "./agent-tools-types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "@/mcp/lib/time"
import { clampLimit } from "@/mcp/lib/limits"
import { formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { readAiToolErrors } from "@/services/ai-sessions/ai-session-reads"
import { AiToolErrorsRequest } from "@maple/domain/http"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Schema } from "effect"

/** Buckets the default trend is cut into, and the most any trend renders. */
const TREND_BUCKETS = 24

/** The group's message in the table; the full text is in `get_agent_tool_error`. */
const MESSAGE_CHARS = 120

export function registerListAgentToolErrorsTool(server: McpToolRegistrar) {
	server.tool(
		"list_agent_tool_errors",
		'Failure groups of one AI agent tool call (the tools an LLM agent invokes during a session — not browser sessions and not Maple\'s own MCP tools), grouped by error fingerprint: what it fails with, how often, in how many sessions, and whether it is still failing. `tool` is an exact tool name from `get_agent_tools_overview`\'s breakdown. Follow a group with `get_agent_tool_error tool="…" fingerprint="…"` for its sessions, message variants and sample payloads.',
		Schema.Struct({
			...agentToolWindowParams,
			tool: requiredStringParam(
				"The tool to list failures for (exact `gen_ai.tool.name`, from `get_agent_tools_overview`)",
			),
			...agentToolSelectionParams,
			bucket_seconds: optionalNumberParam(
				"Trend bucket width in whole seconds. Default: the window split into 24 buckets",
			),
			limit: optionalNumberParam("Max groups to return (default 25, max 100)"),
		}),
		Effect.fn("McpTool.listAgentToolErrors")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "list_agent_tool_errors")
			const startMs = parseWarehouseDateTime(st)
			const endMs = parseWarehouseDateTime(et)
			// The trend is a sparkline beside each group, so its default width is
			// the window over a fixed number of buckets. A minute is the floor: a
			// narrow window would otherwise bucket by seconds.
			const bucketSeconds =
				params.bucket_seconds === undefined
					? Math.max(60, Math.round((endMs - startMs) / 1000 / TREND_BUCKETS))
					: Math.floor(params.bucket_seconds)
			if (bucketSeconds < 1) {
				return validationError(
					`Invalid bucket_seconds: ${params.bucket_seconds}. Must be a whole number of seconds, 1 or more.`,
					`list_agent_tool_errors tool="search_docs" bucket_seconds=3600`,
				)
			}
			const limit = clampLimit(params.limit, { defaultValue: 25, max: 100 })
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				tool: params.tool,
				bucketSeconds,
				limit,
			})

			const errors = yield* readAiToolErrors(
				tenant,
				new AiToolErrorsRequest({
					startTime: st,
					endTime: et,
					bucketSeconds,
					limit,
					...agentToolSelection(params),
					tool: params.tool,
				}),
			).pipe(Effect.catchTags(agentToolReadHandlers("list_agent_tool_errors")))

			const groups = errors.data.map((group) => ({
				...group,
				trend: compactTrend(group.trend, { startMs, endMs, bucketSeconds }, TREND_BUCKETS),
			}))

			const lines: string[] = [
				`## Tool failures: ${params.tool}`,
				`Time range: ${st} — ${et}`,
				`Selection: ${describeSelection(params.tool, params)}`,
				``,
			]

			if (groups.length === 0) {
				lines.push(
					`No failed calls of \`${params.tool}\` in this window.`,
					formatNextSteps([
						`\`get_agent_tools_overview tool="${params.tool}"\` — check the tool ran at all, and how it is named`,
						`\`get_agent_tools_overview\` — the tools that are failing`,
					]),
				)
				return {
					content: agentToolsContent(lines.join("\n"), {
						tool: "list_agent_tool_errors",
						data: {
							timeRange: { start: st, end: et },
							selection: agentToolSelectionData(params.tool, params),
							bucketSeconds,
							groups: [],
						},
					}),
				}
			}

			lines.push(
				`${groups.length} group${groups.length === 1 ? "" : "s"}, most failed calls first. Trend is failed calls per ${bucketSeconds}s bucket, oldest first.`,
				``,
				formatTable(
					[
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
					],
					groups.map((group) => [
						group.fingerprint,
						group.errorType === "" ? "—" : truncate(group.errorType, 40),
						group.message === ""
							? "—"
							: truncate(group.message.replace(/\s+/g, " "), MESSAGE_CHARS),
						formatNumber(group.calls),
						formatNumber(group.sessions),
						formatNumber(group.variants),
						formatSeen(group.firstSeen),
						formatSeen(group.lastSeen),
						formatNumber(group.callsSince),
						group.trend.join(","),
					]),
				),
				``,
				"`Calls since` counts the calls of this tool — failed or not — that came after the group's latest failure: a high count means the group stopped.",
			)

			lines.push(
				formatNextSteps(
					groups
						.slice(0, 3)
						.map(
							(group) =>
								`\`get_agent_tool_error tool="${params.tool}" fingerprint="${group.fingerprint}"\` — sessions, message variants and sample payloads of ${group.errorType === "" ? "this group" : group.errorType} (${formatNumber(group.calls)} calls)`,
						)
						.concat(
							`\`list_agent_sessions tools="${params.tool}" has_errors=true\` — the sessions these failures happened in`,
						),
				),
			)

			return {
				content: agentToolsContent(lines.join("\n"), {
					tool: "list_agent_tool_errors",
					data: {
						timeRange: { start: st, end: et },
						selection: agentToolSelectionData(params.tool, params),
						bucketSeconds,
						groups: groups.map((group) => ({
							fingerprint: group.fingerprint,
							errorType: group.errorType,
							message: group.message,
							calls: group.calls,
							sessions: group.sessions,
							variants: group.variants,
							firstSeen: group.firstSeen,
							lastSeen: group.lastSeen,
							callsSince: group.callsSince,
							trend: [...group.trend],
						})),
					},
				}),
			}
		}),
	)
}

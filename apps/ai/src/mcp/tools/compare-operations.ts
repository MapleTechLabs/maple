import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { CurrentMcpTenant, withTenantExecutor } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { deployWindows, resolveComparisonWindows, type Period } from "../lib/deploys"
import { formatDurationFromMs, formatNumber, formatPercent, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { CompareOperationsOutput } from "@maple/domain/mcp-outputs"
import { compareOperations } from "@maple/query-engine/observability"
import { parseWarehouseDateTime } from "@maple/query-engine"

const TOOL = "compare_operations"
const HOUR_MS = 3_600_000

type Output = typeof CompareOperationsOutput.Type
type Row = Output["operations"][number]

const checkPeriod = (name: "previous" | "current", p: Period) => {
	const ms = parseWarehouseDateTime(p.et) - parseWarehouseDateTime(p.st)
	if (ms <= 0)
		return Effect.fail(
			new McpInvalidInputError({
				message: `The ${name} period is empty or reversed (${p.st} to ${p.et}).`,
				parameter: `${name}_start`,
			}),
		)
	if (ms > MCP_SEARCH_MAX_HOURS * HOUR_MS)
		return Effect.fail(
			new McpInvalidInputError({
				message: `The ${name} period spans ${Math.round(ms / HOUR_MS)} hours; each period covers at most ${MCP_SEARCH_MAX_HOURS}.`,
				parameter: `${name}_start`,
			}),
		)
	return Effect.void
}

const arrow = (before: string, after: string) => (before === after ? after : `${before} -> ${after}`)

export function registerCompareOperationsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Compare Operations",
		description:
			"What changed in one service's operations (span names, HTTP routes) between two windows: operations that are new or gone, whose share of the service's spans doubled or halved, whose error rate rose or fell, or whose p95 moved by half again. Use after a deploy (`since_deploy`), around an incident (`around_time`), or between any two periods; compare_log_patterns does the same for its logs. Reads the per-operation rollups, so it covers whole periods, not samples.",
		parameters: Schema.Struct({
			service: P.text("The service (exact `service.name`)"),
			since_deploy: P.optionalFlag(
				"Compare the hour after the service's newest deploy (up to now) with the same length before it. The deploy is the newest version's first span; after a rollback to an older version, pass around_time instead. Overrides the period bounds",
			),
			around_time: P.optionalTimestamp(
				"Compare the 30 minutes before this time with the 30 minutes after it; overrides the four period bounds",
			),
			current_start: P.optionalTimestamp(
				"Start of the current period (default: 1 hour before current_end)",
			),
			current_end: P.optionalTimestamp("End of the current period (default: now)"),
			previous_start: P.optionalTimestamp(
				"Start of the previous period (default: the current period's length before previous_end)",
			),
			previous_end: P.optionalTimestamp("End of the previous period (default: current_start)"),
			environment: P.environment(),
			limit: P.limit({ default: 30, max: 100, noun: "changed operations" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: CompareOperationsOutput,
		hints: { readOnly: true },
		phrases: ["Comparing operations", "Diffing a service's operations across a deploy"],
		handler: Effect.fn("McpTool.compareOperations")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const fromDeploy =
				params.since_deploy === true
					? yield* deployWindows(TOOL, params.service, params.environment)
					: undefined
			const windows = fromDeploy ?? (yield* resolveComparisonWindows(params))
			const deploy = fromDeploy?.deploy
			yield* checkPeriod("previous", windows.previous)
			yield* checkPeriod("current", windows.current)

			const environment = params.environment ?? deploy?.environment
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.service": params.service,
				"maple.ai.environment": environment ?? "all",
				"maple.ai.since_deploy": params.since_deploy === true,
			})

			const result = yield* withTenantExecutor(
				compareOperations({
					service: params.service,
					before: { startTime: windows.previous.st, endTime: windows.previous.et },
					after: { startTime: windows.current.st, endTime: windows.current.et },
					environment,
					limit: params.limit,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))

			yield* Effect.annotateCurrentSpan("result.rowCount", result.operations.length)

			const window = (w: typeof result.before) => ({
				timeRange: { start: w.timeRange.startTime, end: w.timeRange.endTime },
				spans: w.spans,
				operations: w.operations,
			})
			return {
				service: params.service,
				...(environment === undefined ? undefined : { environment }),
				before: window(result.before),
				after: window(result.after),
				...(deploy === undefined ? undefined : { deploy }),
				operations: result.operations,
				unchanged: result.unchanged,
			}
		}),
		render: (output) => {
			const w = (x: Output["before"]) =>
				`${x.timeRange.start} to ${x.timeRange.end} (${formatNumber(x.spans)} spans, ${x.operations} operations)`
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Service", output.service],
				[
					"Deploy",
					output.deploy === undefined
						? undefined
						: `${Str.slice(0, 7)(output.deploy.commitSha)} in ${output.deploy.environment}, first seen ${output.deploy.firstSeen}`,
				],
				["Before", w(output.before)],
				["After", w(output.after)],
				["Environment", output.environment],
			]
			const after = output.after.timeRange
			const logsNext = doc.next(
				"compare_log_patterns",
				output.deploy === undefined
					? {
							service: output.service,
							environment: output.environment,
							previous_start: output.before.timeRange.start,
							previous_end: output.before.timeRange.end,
							current_start: after.start,
							current_end: after.end,
						}
					: { service: output.service, since_deploy: true, environment: output.environment },
				"see what changed in the service's logs over the same windows",
			)
			if (output.before.spans === 0 || output.after.spans === 0) {
				const side = output.before.spans === 0 ? "before" : "after"
				return {
					title: "Operation Changes",
					scope,
					blocks: [],
					empty: {
						message: `${output.service} has no spans in the ${side} window, so there is nothing to compare.`,
						hints: ["Check the service name with list_services, or widen the windows."],
					},
				}
			}
			if (output.operations.length === 0) {
				return {
					title: "Operation Changes",
					scope,
					blocks: [],
					empty: {
						message: `No operation of ${output.service} changed significantly (${output.unchanged} compared).`,
					},
					next: [logsNext],
				}
			}
			const lead: Row | undefined = output.operations[0]
			const leadNext =
				lead === undefined
					? []
					: Arr.contains(lead.flags, "slower")
						? [
								doc.next(
									"search_traces",
									{
										service: output.service,
										span_name: lead.operation,
										min_duration_ms: Math.round(lead.after.p95Ms),
										start_time: after.start,
										end_time: after.end,
									},
									"read the slow traces behind the top change",
								),
							]
						: [
								doc.next(
									"search_traces",
									{
										service: output.service,
										span_name: lead.operation,
										...(Arr.contains(lead.flags, "errors_up")
											? { has_error: true }
											: undefined),
										start_time: after.start,
										end_time: after.end,
									},
									"read traces of the top changed operation",
								),
							]
			return {
				title: `Operation Changes (${output.operations.length})`,
				scope,
				blocks: [
					doc.table(
						["Operation", "Change", "Spans", "Error rate", "p95"],
						Arr.map(output.operations, (o) => [
							truncate(o.operation, 80),
							Arr.join(o.flags, ", "),
							arrow(formatNumber(o.before.spans), formatNumber(o.after.spans)),
							arrow(formatPercent(o.before.errorRate), formatPercent(o.after.errorRate)),
							arrow(formatDurationFromMs(o.before.p95Ms), formatDurationFromMs(o.after.p95Ms)),
						]),
					),
					doc.text(
						`${output.unchanged} other operations did not change significantly. Volume changes compare each operation's share of the service's spans, so a traffic rise alone flags nothing.`,
					),
				],
				next: [...leadNext, logsNext],
			}
		},
	})
}

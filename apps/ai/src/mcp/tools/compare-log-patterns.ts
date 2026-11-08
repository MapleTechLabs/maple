import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_LOG_PATTERN_MAX_HOURS } from "../lib/time"
import { deployWindows, resolveComparisonWindows, type Period } from "../lib/deploys"
import { truncate, formatNumber, topKey } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { CompareLogPatternsOutput } from "@maple/domain/mcp-outputs"
import { compareLogPatterns, hasErrorSeverity } from "@maple/query-engine/observability"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { LOG_SEVERITIES, logFilterScope, logFilters } from "./search-logs"

const TOOL = "compare_log_patterns"
const HOUR_MS = 3_600_000

type Output = typeof CompareLogPatternsOutput.Type
type Row = Output["patterns"][number]

const lengthMs = (p: Period) => parseWarehouseDateTime(p.et) - parseWarehouseDateTime(p.st)

/** The longest run of literal tokens in a template: a body substring that finds its logs. */
export const templateProbe = (template: string): string | undefined => {
	const runs = Arr.map(Str.split(template, /\S*<[^>]*>\S*/), Str.trim)
	const best = Arr.reduce(runs, "", (acc, run) => (run.length > acc.length ? run : acc))
	return best.length >= 4 ? truncate(best, 80) : undefined
}

const describeChange = (p: Row): string => {
	const counts = `${formatNumber(p.before.estimated)} -> ${formatNumber(p.after.estimated)}`
	return p.ratio === undefined ? counts : `${counts} (${p.ratio}x share)`
}

const checkPeriod = (name: "previous" | "current", p: Period) => {
	const ms = lengthMs(p)
	if (ms <= 0)
		return Effect.fail(
			new McpInvalidInputError({
				message: `The ${name} period is empty or reversed (${p.st} to ${p.et}).`,
				parameter: `${name}_start`,
			}),
		)
	if (ms > MCP_LOG_PATTERN_MAX_HOURS * HOUR_MS)
		return Effect.fail(
			new McpInvalidInputError({
				message: `The ${name} period spans ${Math.round(ms / HOUR_MS)} hours; each period covers at most ${MCP_LOG_PATTERN_MAX_HOURS}.`,
				parameter: `${name}_start`,
			}),
		)
	return Effect.void
}

export function registerCompareLogPatternsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Compare Log Patterns",
		description:
			"What changed in the logs between two windows: log templates that are new, gone, or whose share of the logs at least doubled or halved. Use after a deploy (`since_deploy` with `service`), around an incident (`around_time`), or between any two periods. Each side samples the logs nearest the boundary (the previous period's newest, the current period's oldest) and both are clustered together, so a template means the same on both sides; error-level logs cluster apart from the rest. Changes are judged on share of logs, so a traffic rise alone flags nothing.",
		parameters: Schema.Struct({
			since_deploy: P.optionalFlag(
				"Compare the hour after `service`'s newest deploy (up to now) with the same length before it. The deploy is the newest version's first span; after a rollback to an older version, pass around_time instead. Overrides the period bounds",
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
			service: P.service(),
			environment: P.environment(),
			severity: P.optionalOneOf(
				LOG_SEVERITIES,
				"Only logs at this severity level (matches every SDK spelling of it)",
			),
			search: P.optionalText("Substring of the log body, applied before clustering"),
			sample_size: P.limit({
				default: 5_000,
				max: 25_000,
				description:
					"Logs sampled per period, nearest the boundary; more covers more of each period, costs more",
			}),
			limit: P.limit({ default: 30, max: 100, noun: "changed patterns" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: CompareLogPatternsOutput,
		hints: { readOnly: true },
		phrases: ["Comparing log patterns", "Diffing logs across a deploy"],
		handler: Effect.fn("McpTool.compareLogPatterns")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			if (params.since_deploy === true && params.service === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"`since_deploy` needs `service`: the service whose newest deploy splits the windows.",
					parameter: "service",
					example: '{"since_deploy":true,"service":"checkout"}',
				})
			}
			const fromDeploy =
				params.since_deploy === true && params.service !== undefined
					? yield* deployWindows(TOOL, params.service, params.environment)
					: undefined
			const windows = fromDeploy ?? (yield* resolveComparisonWindows(params))
			const deploy = fromDeploy?.deploy
			yield* checkPeriod("previous", windows.previous)
			yield* checkPeriod("current", windows.current)

			// A deploy scopes the comparison to the deployed service in the environment it shipped to.
			const environment = params.environment ?? deploy?.environment
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.service": params.service ?? "all",
				"maple.ai.environment": environment ?? "all",
				"maple.ai.since_deploy": params.since_deploy === true,
				"maple.ai.window_minutes": Math.round(lengthMs(windows.current) / 60_000),
				"maple.ai.sample_size": params.sample_size,
			})

			const result = yield* compareLogPatterns({
				before: { startTime: windows.previous.st, endTime: windows.previous.et },
				after: { startTime: windows.current.st, endTime: windows.current.et },
				service: params.service,
				severity: params.severity,
				search: params.search,
				environment,
				sampleSize: params.sample_size,
				limit: params.limit,
			}).pipe(provideWarehouseExecutorFromTenant(tenant), Effect.mapError(toMcpQueryError(TOOL)))

			yield* Effect.annotateCurrentSpan("result.rowCount", result.patterns.length)

			const window = (w: typeof result.before) => ({
				timeRange: { start: w.timeRange.startTime, end: w.timeRange.endTime },
				totalLogs: w.totalLogs,
				sampled: w.sampled,
				...(w.sampleCoverage === undefined
					? undefined
					: {
							sampleCoverage: {
								start: w.sampleCoverage.startTime,
								end: w.sampleCoverage.endTime,
							},
						}),
			})
			return {
				before: window(result.before),
				after: window(result.after),
				...(deploy === undefined ? undefined : { deploy }),
				sampleSize: result.sampleSize,
				patterns: result.patterns,
				unchanged: result.unchanged,
				filters: logFilters(params),
				...(environment === undefined ? undefined : { environment }),
			}
		}),
		render: (output) => {
			const w = (x: Output["before"]) =>
				`${x.timeRange.start} to ${x.timeRange.end} (${formatNumber(x.totalLogs)} logs, ${formatNumber(x.sampled)} sampled${x.sampleCoverage === undefined ? "" : ` from ${x.sampleCoverage.start} to ${x.sampleCoverage.end}`})`
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				[
					"Deploy",
					output.deploy === undefined
						? undefined
						: `${output.deploy.service} ${Str.slice(0, 7)(output.deploy.commitSha)} in ${output.deploy.environment}, first seen ${output.deploy.firstSeen}`,
				],
				["Before", w(output.before)],
				["After", w(output.after)],
				["Environment", output.environment],
				...logFilterScope(output.filters),
			]
			const deployNext =
				output.deploy === undefined
					? []
					: [
							doc.next(
								"compare_commits",
								{ service: output.deploy.service, environment: output.deploy.environment },
								"list the commits this deploy shipped",
							),
							doc.next(
								"compare_operations",
								{
									service: output.deploy.service,
									since_deploy: true,
									environment: output.deploy.environment,
								},
								"see which of the service's operations changed with the deploy",
							),
						]
			if (output.before.sampled === 0 || output.after.sampled === 0) {
				const empty = Arr.filter([output.before, output.after], (x) => x.sampled === 0)
				const sides = Arr.join(
					Arr.map(empty, (x) => (x === output.before ? "before" : "after")),
					" and ",
				)
				const bodiless = Arr.some(empty, (x) => x.totalLogs > 0)
				return {
					title: "Log Pattern Changes",
					scope,
					blocks: [],
					empty: {
						message: bodiless
							? `No log bodies to cluster in the ${sides} window (${Arr.join(
									Arr.map(empty, (x) => `${formatNumber(x.totalLogs)} logs, 0 with a body`),
									"; ",
								)}).`
							: `No logs in the ${sides} window, so there is nothing to compare.`,
						hints: bodiless
							? [
									"These logs carry their content in attributes, not the body; search_logs shows them.",
								]
							: ["Widen the windows, drop filters, or check ingest_freshness for a gap."],
					},
					next: deployNext,
				}
			}
			if (output.patterns.length === 0) {
				return {
					title: "Log Pattern Changes",
					scope,
					blocks: [],
					empty: {
						message: `No log template changed significantly between the samples (${output.unchanged} templates compared).`,
						hints: [
							"Raise sample_size to cover more of each period, or narrow with service/severity.",
						],
					},
					next: deployNext,
				}
			}
			const counts = Arr.filterMap(["new", "up", "gone", "down"] as const, (c) => {
				const n = Arr.filter(output.patterns, (p) => p.change === c).length
				return n === 0 ? Result.failVoid : Result.succeed(`${n} ${c}`)
			})
			const lead = Arr.findFirst(output.patterns, (p) => p.change === "new" || p.change === "up")
			const probe = Option.flatMapNullishOr(lead, (p) => templateProbe(p.template))
			return {
				title: `Log Pattern Changes (${Arr.join(counts, ", ")})`,
				scope,
				blocks: [
					doc.table(
						["Change", "Before -> after (est.)", "Severity", "Service", "Template"],
						Arr.map(output.patterns, (p) => [
							Str.toUpperCase(p.change),
							describeChange(p),
							topKey(p.severityCounts),
							topKey(p.serviceCounts),
							truncate(p.template, 140),
						]),
					),
					doc.text(
						`${output.unchanged} other templates did not change significantly. Counts are each template's share of its period's sample, scaled to the period's total.`,
					),
				],
				next: [
					...(Option.isSome(lead) && Option.isSome(probe)
						? [
								doc.next(
									"search_logs",
									{
										service: topKey(lead.value.serviceCounts),
										...(hasErrorSeverity(lead.value.severityCounts)
											? { severity: "ERROR" }
											: undefined),
										search: probe.value,
										start_time: output.after.timeRange.start,
										end_time: output.after.timeRange.end,
									},
									"read the logs behind the top emerging template",
								),
							]
						: []),
					...deployNext,
				],
			}
		},
	})
}

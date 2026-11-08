import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_LOG_PATTERN_MAX_HOURS, resolveTimeRange } from "../lib/time"
import { serviceDeploysNewestFirst } from "../lib/deploys"
import { truncate, formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Clock, DateTime, Effect, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { CompareLogPatternsOutput } from "@maple/domain/mcp-outputs"
import { compareLogPatterns, hasErrorSeverity } from "@maple/query-engine/observability"
import { parseWarehouseDateTime, warehouseDateTime, type WarehouseDateTime } from "@maple/query-engine"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { LOG_SEVERITIES, logFilterScope, logFilters } from "./search-logs"

const TOOL = "compare_log_patterns"
const HOUR_MS = 3_600_000
const HALF_WINDOW_MS = 30 * 60 * 1000
const DEPLOY_LOOKBACK_HOURS = 14 * 24

type Output = typeof CompareLogPatternsOutput.Type
type Row = Output["patterns"][number]

interface Windows {
	readonly before: { readonly st: WarehouseDateTime; readonly et: WarehouseDateTime }
	readonly after: { readonly st: WarehouseDateTime; readonly et: WarehouseDateTime }
	readonly deploy?: Output["deploy"]
}

const span = (st: WarehouseDateTime, et: WarehouseDateTime) =>
	parseWarehouseDateTime(et) - parseWarehouseDateTime(st)

const sameLengthBefore = (st: WarehouseDateTime, lengthMs: number) => ({
	st: warehouseDateTime(parseWarehouseDateTime(st) - lengthMs),
	et: st,
})

/** The longest run of literal tokens in a template: a body substring that finds its logs. */
export const templateProbe = (template: string): string | undefined => {
	const runs = Arr.map(Str.split(template, /\S*<[^>]*>\S*/), Str.trim)
	const best = Arr.reduce(runs, "", (acc, run) => (run.length > acc.length ? run : acc))
	return best.length >= 4 ? truncate(best, 80) : undefined
}

const topKey = (counts: { readonly [key: string]: number }): string =>
	Arr.reduce(Rec.toEntries(counts), { key: "unknown", n: -1 }, (best, [key, n]) =>
		n > best.n ? { key, n } : best,
	).key

const LABEL = { new: "NEW", up: "UP", gone: "GONE", down: "DOWN" } as const satisfies Record<
	Row["change"],
	string
>

const describeChange = (p: Row): string => {
	const counts = `${formatNumber(p.before.estimated)} -> ${formatNumber(p.after.estimated)}`
	return p.ratio === undefined ? counts : `${counts} (${p.ratio}x share)`
}

/** After = from the service's newest deploy to now (at most a day), before = the same length before it. */
const deployWindows = Effect.fn("McpTool.compareLogPatterns.deployWindows")(function* (
	service: string | undefined,
	environment: string | undefined,
) {
	if (service === undefined) {
		return yield* new McpInvalidInputError({
			message: "`since_deploy` needs `service`: the service whose newest deploy splits the windows.",
			parameter: "service",
			example: '{"since_deploy":true,"service":"checkout"}',
		})
	}
	const now = yield* Clock.currentTimeMillis
	const deploys = yield* serviceDeploysNewestFirst(
		TOOL,
		"compareLogPatternsDeploys",
		service,
		environment,
		warehouseDateTime(now - DEPLOY_LOOKBACK_HOURS * HOUR_MS),
		warehouseDateTime(now),
	)
	const newest = deploys[0]
	if (newest === undefined) {
		return yield* new McpInvalidInputError({
			message: `${service} reported no version (vcs.ref.head.revision) in the last 14 days${environment ? ` in ${environment}` : ""}, so there is no deploy to split at. service_deployments lists the services that report versions; otherwise pass around_time with the deploy time.`,
			parameter: "service",
		})
	}
	const boundaryMs = DateTime.toEpochMillis(newest.firstSeen)
	const boundary = warehouseDateTime(boundaryMs)
	const after = {
		st: boundary,
		et: warehouseDateTime(Math.min(now, boundaryMs + MCP_LOG_PATTERN_MAX_HOURS * HOUR_MS)),
	}
	return {
		before: sameLengthBefore(boundary, span(after.st, after.et)),
		after,
		deploy: {
			service: newest.serviceName,
			environment: newest.environment,
			commitSha: newest.commitSha,
			firstSeen: boundary,
		},
	} satisfies Windows
})

/** `around_time`'s half hours, or the explicit periods with compare_periods' defaults. */
const periodWindows = (params: {
	readonly around_time?: WarehouseDateTime | undefined
	readonly current_start?: WarehouseDateTime | undefined
	readonly current_end?: WarehouseDateTime | undefined
	readonly previous_start?: WarehouseDateTime | undefined
	readonly previous_end?: WarehouseDateTime | undefined
}): Windows => {
	if (params.around_time !== undefined) {
		const center = parseWarehouseDateTime(params.around_time)
		return {
			before: { st: warehouseDateTime(center - HALF_WINDOW_MS), et: params.around_time },
			after: { st: params.around_time, et: warehouseDateTime(center + HALF_WINDOW_MS) },
		}
	}
	const current = resolveTimeRange(params.current_start, params.current_end, 1)
	const prevEt = params.previous_end ?? current.st
	const prevSt =
		params.previous_start ??
		warehouseDateTime(parseWarehouseDateTime(prevEt) - span(current.st, current.et))
	return { before: { st: prevSt, et: prevEt }, after: { st: current.st, et: current.et } }
}

export function registerCompareLogPatternsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Compare Log Patterns",
		description:
			"What changed in the logs between two windows: log templates that are new, gone, or whose share of the logs at least doubled or halved. Use after a deploy (`since_deploy` with `service` compares the time since its newest version first appeared with the same length before it), around an incident (`around_time`), or between any two periods. Each window is a sample of its most recent logs, clustered together so a template means the same on both sides; changes are judged on share of logs, so a traffic rise alone flags nothing.",
		parameters: Schema.Struct({
			since_deploy: P.optionalFlag(
				"Split at `service`'s newest deploy: after = from its first span to now (at most 24 hours), before = the same length before it. Overrides the period bounds",
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
				description: "Recent logs sampled per window; more finds rarer templates, costs more",
			}),
			limit: P.limit({ default: 30, max: 100, noun: "changed patterns" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: CompareLogPatternsOutput,
		hints: { readOnly: true },
		phrases: ["Comparing log patterns", "Diffing logs across a deploy"],
		handler: Effect.fn("McpTool.compareLogPatterns")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const windows =
				params.since_deploy === true
					? yield* deployWindows(params.service, params.environment)
					: periodWindows(params)

			yield* Effect.forEach(
				[
					["previous", windows.before],
					["current", windows.after],
				] as const,
				([name, w]) => {
					const lengthMs = span(w.st, w.et)
					if (lengthMs <= 0)
						return Effect.fail(
							new McpInvalidInputError({
								message: `The ${name} period is empty or reversed (${w.st} to ${w.et}).`,
								parameter: `${name}_start`,
							}),
						)
					if (lengthMs > MCP_LOG_PATTERN_MAX_HOURS * HOUR_MS)
						return Effect.fail(
							new McpInvalidInputError({
								message: `The ${name} period spans ${Math.round(lengthMs / HOUR_MS)} hours; each period covers at most ${MCP_LOG_PATTERN_MAX_HOURS}.`,
								parameter: `${name}_start`,
							}),
						)
					return Effect.void
				},
				{ discard: true },
			)

			// A deploy scopes the comparison to the deployed service in the environment it shipped to.
			const environment = params.environment ?? windows.deploy?.environment
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.service": params.service ?? "all",
				"maple.ai.environment": environment ?? "all",
				"maple.ai.since_deploy": params.since_deploy === true,
				"maple.ai.window_minutes": Math.round(span(windows.after.st, windows.after.et) / 60_000),
				"maple.ai.sample_size": params.sample_size,
			})

			const result = yield* compareLogPatterns({
				before: { startTime: windows.before.st, endTime: windows.before.et },
				after: { startTime: windows.after.st, endTime: windows.after.et },
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
			})
			return {
				before: window(result.before),
				after: window(result.after),
				...(windows.deploy === undefined ? undefined : { deploy: windows.deploy }),
				sampleSize: result.sampleSize,
				patterns: result.patterns,
				unchanged: result.unchanged,
				filters: logFilters(params),
				...(environment === undefined ? undefined : { environment }),
			}
		}),
		render: (output) => {
			const w = (x: Output["before"]) =>
				`${x.timeRange.start} to ${x.timeRange.end} (${formatNumber(x.totalLogs)} logs, ${formatNumber(x.sampled)} sampled)`
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
						]
			if (output.before.sampled === 0 || output.after.sampled === 0) {
				const side = output.before.sampled === 0 ? "before" : "after"
				return {
					title: "Log Pattern Changes",
					scope,
					blocks: [],
					empty: {
						message: `No logs in the ${side} window, so there is nothing to compare.`,
						hints: ["Widen the windows, drop filters, or check ingest_freshness for a gap."],
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
						message: `No log template changed significantly (${output.unchanged} templates held steady).`,
						hints: [
							"Raise sample_size to catch rarer templates, or narrow with service/severity.",
						],
					},
					next: deployNext,
				}
			}
			const counts = Arr.map(["new", "up", "gone", "down"] as const, (c) => {
				const n = Arr.filter(output.patterns, (p) => p.change === c).length
				return n === 0 ? undefined : `${n} ${c}`
			})
			const lead = Arr.findFirst(output.patterns, (p) => p.change === "new" || p.change === "up")
			const probe = lead._tag === "Some" ? templateProbe(lead.value.template) : undefined
			return {
				title: `Log Pattern Changes (${Arr.join(
					Arr.filter(counts, (c) => c !== undefined),
					", ",
				)})`,
				scope,
				blocks: [
					doc.table(
						["Change", "Before -> after (est.)", "Severity", "Service", "Template"],
						Arr.map(output.patterns, (p) => [
							LABEL[p.change],
							describeChange(p),
							topKey(p.severityCounts),
							topKey(p.serviceCounts),
							truncate(p.template, 140),
						]),
					),
					doc.text(
						`${output.unchanged} other templates held steady. Counts are each template's share of its window's sample, scaled to the window's total.`,
					),
				],
				next: [
					...(lead._tag === "Some" && probe !== undefined
						? [
								doc.next(
									"search_logs",
									{
										service: topKey(lead.value.serviceCounts),
										...(hasErrorSeverity(lead.value.severityCounts)
											? { severity: "ERROR" }
											: undefined),
										search: probe,
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

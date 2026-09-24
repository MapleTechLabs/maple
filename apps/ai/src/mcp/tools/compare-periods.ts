import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { queryWarehouse } from "../lib/query-warehouse"
import { getSpamPatternsParam } from "@maple/backend/services/errors/spam-patterns"
import { resolveTimeRange } from "../lib/time"
import { formatDelta, formatPercent, formatDurationFromMs, formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ComparePeriodsOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"

type Output = typeof ComparePeriodsOutput.Type
type RegressionFlag = NonNullable<Output["services"][number]["flags"]>[number]

interface ErrorsSummaryRow {
	readonly totalErrors: number | string
	readonly totalSpans: number | string
	readonly errorRate: number
}

interface ServiceOverviewRow {
	readonly serviceName: string
	readonly throughput: number | string
	readonly errorCount: number | string
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
}

interface ServiceAggregate {
	throughput: number
	errorCount: number
	p95: number
	totalWeight: number
}

/** Per-service totals across environments, with P95 weighted by throughput. */
const aggregateServices = (rows: ReadonlyArray<ServiceOverviewRow>, service: string | undefined) => {
	const map = new Map<string, ServiceAggregate>()
	for (const row of rows) {
		if (service !== undefined && row.serviceName !== service) continue
		const tp = Number(row.throughput)
		const existing = map.get(row.serviceName) ?? { throughput: 0, errorCount: 0, p95: 0, totalWeight: 0 }
		existing.throughput += tp
		existing.errorCount += Number(row.errorCount)
		existing.p95 += row.p95LatencyMs * tp
		existing.totalWeight += tp
		map.set(row.serviceName, existing)
	}
	return map
}

const statsOf = (agg: ServiceAggregate | undefined) => ({
	throughput: agg?.throughput ?? 0,
	errorRate: agg !== undefined && agg.throughput > 0 ? agg.errorCount / agg.throughput : 0,
	p95Ms: agg !== undefined && agg.totalWeight > 0 ? agg.p95 / agg.totalWeight : 0,
})

const overallOf = (row: ErrorsSummaryRow | undefined) => ({
	totalSpans: row === undefined ? 0 : Number(row.totalSpans),
	totalErrors: row === undefined ? 0 : Number(row.totalErrors),
	errorRate: row === undefined ? 0 : row.errorRate,
})

const HALF_WINDOW_MS = 30 * 60 * 1000

export function registerComparePeriodsTool(server: McpToolRegistrar) {
	server.define({
		name: "compare_periods",
		description:
			"Compare error rate, throughput and P95 between two periods, overall and per service, and flag regressions (error_rate_up, latency_up, throughput_drop). Useful after a deploy or an incident report.",
		parameters: Schema.Struct({
			current_start: P.optionalTimestamp(
				"Start of the current period (default: 1 hour before current_end)",
			),
			current_end: P.optionalTimestamp("End of the current period (default: now)"),
			previous_start: P.optionalTimestamp(
				"Start of the previous period (default: the current period's length before previous_end)",
			),
			previous_end: P.optionalTimestamp("End of the previous period (default: current_start)"),
			around_time: P.optionalTimestamp(
				"Compare the 30 minutes before this time with the 30 minutes after it; overrides the four period bounds",
			),
			service: P.service("Scope the comparison to this service (exact `service.name`)"),
			environment: P.environment(),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ComparePeriodsOutput,
		hints: { readOnly: true },
		phrases: ["Comparing time periods", "Comparing against an earlier period"],
		handler: Effect.fn("McpTool.comparePeriods")(function* (params) {
			let curSt: string, curEt: string, prevSt: string, prevEt: string

			if (params.around_time !== undefined) {
				const center = parseWarehouseDateTime(params.around_time)
				prevSt = formatWarehouseDateTime(center - HALF_WINDOW_MS)
				prevEt = params.around_time
				curSt = params.around_time
				curEt = formatWarehouseDateTime(center + HALF_WINDOW_MS)
			} else {
				const current = resolveTimeRange(params.current_start, params.current_end, 1)
				if (current.requestedHours < 0) {
					return yield* new McpInvalidInputError({
						message: `current_start (${current.st}) is after current_end (${current.et}).`,
						parameter: "current_start",
					})
				}
				curSt = current.st
				curEt = current.et
				// The previous period defaults to the same duration, immediately before the current one.
				const currentStartMs = parseWarehouseDateTime(current.st)
				const durationMs = parseWarehouseDateTime(current.et) - currentStartMs
				prevEt = params.previous_end ?? current.st
				prevSt =
					params.previous_start ??
					formatWarehouseDateTime(parseWarehouseDateTime(prevEt) - durationMs)
				if (parseWarehouseDateTime(prevSt) > parseWarehouseDateTime(prevEt)) {
					return yield* new McpInvalidInputError({
						message: `previous_start (${prevSt}) is after previous_end (${prevEt}).`,
						parameter: "previous_start",
					})
				}
			}

			const service = params.service
			const environment = params.environment
			const [currentSummary, previousSummary, currentServices, previousServices] = yield* Effect.all(
				[
					queryWarehouse<ErrorsSummaryRow>("errors_summary", {
						start_time: curSt,
						end_time: curEt,
						exclude_spam_patterns: getSpamPatternsParam(),
						...(service !== undefined && { services: service }),
						...(environment !== undefined && { deployment_envs: environment }),
					}),
					queryWarehouse<ErrorsSummaryRow>("errors_summary", {
						start_time: prevSt,
						end_time: prevEt,
						exclude_spam_patterns: getSpamPatternsParam(),
						...(service !== undefined && { services: service }),
						...(environment !== undefined && { deployment_envs: environment }),
					}),
					queryWarehouse<ServiceOverviewRow>("service_overview", {
						start_time: curSt,
						end_time: curEt,
						...(environment !== undefined && { environments: environment }),
					}),
					queryWarehouse<ServiceOverviewRow>("service_overview", {
						start_time: prevSt,
						end_time: prevEt,
						...(environment !== undefined && { environments: environment }),
					}),
				],
				{ concurrency: "unbounded" },
			)

			const currentSvcMap = aggregateServices(currentServices.data, service)
			const previousSvcMap = aggregateServices(previousServices.data, service)
			const allServiceNames = [...new Set([...currentSvcMap.keys(), ...previousSvcMap.keys()])]

			return {
				currentPeriod: { start: curSt, end: curEt },
				previousPeriod: { start: prevSt, end: prevEt },
				overall: {
					current: overallOf(currentSummary.data[0]),
					previous: overallOf(previousSummary.data[0]),
				},
				services: allServiceNames.map((name) => {
					const current = statsOf(currentSvcMap.get(name))
					const previous = statsOf(previousSvcMap.get(name))
					const flags: Array<RegressionFlag> = []
					if (previous.errorRate > 0 && current.errorRate / previous.errorRate > 1.5)
						flags.push("error_rate_up")
					if (previous.p95Ms > 0 && current.p95Ms / previous.p95Ms > 2) flags.push("latency_up")
					if (previous.throughput > 0 && current.throughput / previous.throughput < 0.5)
						flags.push("throughput_drop")
					return { name, current, previous, flags }
				}),
				...(service === undefined ? undefined : { service }),
				...(environment === undefined ? undefined : { environment }),
			}
		}),
		render: (output) => {
			const { current, previous } = output.overall
			const blocks: Array<DocBlock> = [
				doc.heading("Overall"),
				doc.table(
					["Metric", "Previous", "Current", "Change"],
					[
						[
							"Total spans",
							formatNumber(previous.totalSpans),
							formatNumber(current.totalSpans),
							formatDelta(current.totalSpans, previous.totalSpans),
						],
						[
							"Total errors",
							formatNumber(previous.totalErrors),
							formatNumber(current.totalErrors),
							formatDelta(current.totalErrors, previous.totalErrors),
						],
						[
							"Error rate",
							formatPercent(previous.errorRate),
							formatPercent(current.errorRate),
							formatDelta(current.errorRate, previous.errorRate),
						],
					],
				),
			]
			if (output.services.length > 0) {
				blocks.push(
					doc.heading("Per-Service"),
					doc.table(
						[
							"Service",
							"Prev Throughput",
							"Curr Throughput",
							"Prev Error Rate",
							"Curr Error Rate",
							"Prev P95",
							"Curr P95",
							"Flags",
						],
						output.services.map((s) => [
							s.name,
							formatNumber(s.previous.throughput),
							formatNumber(s.current.throughput),
							formatPercent(s.previous.errorRate),
							formatPercent(s.current.errorRate),
							formatDurationFromMs(s.previous.p95Ms),
							formatDurationFromMs(s.current.p95Ms),
							(s.flags ?? []).join(", ") || "-",
						]),
					),
				)
			}
			const regressions = output.services.filter((s) => (s.flags ?? []).length > 0).slice(0, 3)
			const errorsUp = current.errorRate > previous.errorRate && current.errorRate > 0.01
			const next = [
				...regressions.map((s) =>
					doc.next(
						"diagnose_service",
						{
							service: s.name,
							start_time: output.currentPeriod.start,
							end_time: output.currentPeriod.end,
						},
						"investigate regression",
					),
				),
				...(errorsUp
					? [
							doc.next(
								"find_errors",
								{
									start_time: output.currentPeriod.start,
									end_time: output.currentPeriod.end,
								},
								"categorize new errors",
							),
						]
					: []),
			]
			return {
				title: "Period Comparison",
				scope: [
					["Current", `${output.currentPeriod.start} to ${output.currentPeriod.end}`],
					["Previous", `${output.previousPeriod.start} to ${output.previousPeriod.end}`],
					["Service", output.service],
					["Environment", output.environment],
				],
				blocks,
				next: next.length > 0 ? next : [doc.next("list_services", {}, "see current service health")],
			}
		},
	})
}

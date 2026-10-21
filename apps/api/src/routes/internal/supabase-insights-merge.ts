import type {
	SupabaseApiTrafficSeriesOutput,
	SupabaseApiTrafficTotalsOutput,
	SupabaseLogsProjectSummaryOutput,
	SupabaseProjectCallerSeriesOutput,
	SupabaseProjectCallersOutput,
	SupabaseProjectCpuOutput,
	SupabaseProjectGaugesOutput,
} from "@maple/query-engine-integrations"
import {
	SupabaseApiTrafficBucket,
	SupabaseApiTrafficResponse,
	SupabaseCallerBucket,
	SupabaseCallerMix,
	SupabaseProjectCaller,
} from "@maple/domain/http"
import { Array as Arr, DateTime } from "effect"

// /infra/supabase: joins of the metrics, logs and trace reads behind the insights endpoints.

const METRIC_ZEROS = {
	cpuAvg: 0,
	cpuMax: 0,
	memoryAvg: 0,
	memoryMax: 0,
	memoryTotal: 0,
	diskUsedMax: 0,
	diskSize: 0,
	dbSize: 0,
	connectionsAvg: 0,
	connectionsMax: 0,
	maxConnections: 0,
}

const LOG_ZEROS = { requests: 0, requestsPerMinute: 0, errors5xx: 0, issueCount: 0 }

/**
 * One row per project with metrics or logs in the window: the scraped gauges and CPU, plus edge
 * request and WARN+ log counts. A project with only logs reads zero metrics; `lastSeen` is the
 * metrics' when there are any, else the logs'.
 */
export const mergeSupabaseProjects = (
	gauges: ReadonlyArray<SupabaseProjectGaugesOutput>,
	cpu: ReadonlyArray<SupabaseProjectCpuOutput>,
	logs: ReadonlyArray<SupabaseLogsProjectSummaryOutput>,
) => {
	const cpuByRef = new Map(cpu.map((row) => [row.projectRef, row]))
	const logsByRef = new Map(
		logs.map((row) => [
			row.projectRef,
			{
				requests: row.requests,
				requestsPerMinute: row.requestsPerMinute,
				errors5xx: row.errors5xx,
				issueCount: row.issueCount,
			},
		]),
	)
	const fromMetrics = gauges.map((row) => ({
		...row,
		cpuAvg: cpuByRef.get(row.projectRef)?.cpuAvg ?? 0,
		cpuMax: cpuByRef.get(row.projectRef)?.cpuMax ?? 0,
		...LOG_ZEROS,
		...logsByRef.get(row.projectRef),
		lastSeen: DateTime.formatIso(row.lastSeen),
	}))
	const withMetrics = new Set(gauges.map((row) => row.projectRef))
	const logsOnly = logs
		.filter((row) => !withMetrics.has(row.projectRef))
		.map(({ lastSeen, ...row }) => ({ ...METRIC_ZEROS, ...row, lastSeen: DateTime.formatIso(lastSeen) }))
	return [...fromMetrics, ...logsOnly].toSorted((a, b) => a.projectRef.localeCompare(b.projectRef))
}

/** The bucketed status classes and the window totals as one response. */
export const apiTrafficResponse = (
	series: ReadonlyArray<SupabaseApiTrafficSeriesOutput>,
	totals: SupabaseApiTrafficTotalsOutput | undefined,
) => {
	const requests = totals?.requests ?? 0
	const errors5xx = totals?.errors5xx ?? 0
	return new SupabaseApiTrafficResponse({
		buckets: series.map((row) => new SupabaseApiTrafficBucket(row)),
		requests,
		errors5xx,
		errorRate5xx: requests > 0 ? errors5xx / requests : 0,
		p95OriginMs: totals?.p95OriginMs ?? 0,
	})
}

/** Each caller with its product mix and its own buckets, in the callers' order. */
export const mergeSupabaseCallers = (
	callers: ReadonlyArray<SupabaseProjectCallersOutput>,
	series: ReadonlyArray<SupabaseProjectCallerSeriesOutput>,
) => {
	const seriesByService = Arr.groupBy(series, (row) => row.serviceName)
	return callers.map(
		(row) =>
			new SupabaseProjectCaller({
				serviceName: row.serviceName,
				calls: row.calls,
				callsPerMinute: row.callsPerMinute,
				errors: row.errors,
				errorRate: row.errorRate,
				p95DurationMs: row.p95DurationMs,
				mix: new SupabaseCallerMix({
					rest: row.rest,
					auth: row.auth,
					storage: row.storage,
					realtime: row.realtime,
					functions: row.functions,
					postgres: row.postgres,
					other: row.other,
				}),
				series: (seriesByService[row.serviceName] ?? []).map(
					(point) => new SupabaseCallerBucket({ bucket: point.bucket, calls: point.calls }),
				),
			}),
	)
}

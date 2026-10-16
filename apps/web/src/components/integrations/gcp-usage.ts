// The Google Cloud integration page's numbers at a glance, cut from reads Maple already makes:
// the log volume chart's query, the Infrastructure fleet and the resource inventory. Pure.

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"

import { toIsoBucket } from "@/api/warehouse/timeseries-utils"

const HOUR_MS = 3_600_000

/** What marks a log entry as forwarded by this integration: see `apps/ingest/src/gcp_logging.rs`. */
export const GCP_LOG_SOURCE = { key: "maple_ingest_source", value: "gcp-logpush" } as const

const ERROR_SEVERITY = /^(err|crit|alert|emerg|fatal)/i
const WARNING_SEVERITY = /^warn/i

/**
 * Forwarded log entries over the window, from the read's rows by hour and severity: the total, how
 * many are errors or worse and how many warnings, and the entries per hour, oldest first. The read
 * returns only hours that have entries and drops a partial first hour, so the window starts at its
 * first full hour and an hour without a row counts zero.
 */
export function gcpLogVolume(
	points: ReadonlyArray<{ readonly bucket: string; readonly series: Readonly<Record<string, number>> }>,
	startMs: number,
	endMs: number,
): {
	readonly total: number
	readonly errors: number
	readonly warnings: number
	readonly hourly: ReadonlyArray<number>
} {
	const first = Math.ceil(startMs / HOUR_MS) * HOUR_MS
	const hourly = Array.from({ length: Math.max(1, Math.floor((endMs - first) / HOUR_MS) + 1) }, () => 0)
	let errors = 0
	let warnings = 0
	for (const point of points) {
		const hour = Math.floor((Date.parse(toIsoBucket(point.bucket)) - first) / HOUR_MS)
		if (hour < 0 || hour >= hourly.length) continue
		for (const [severity, entries] of Object.entries(point.series)) {
			hourly[hour] += entries
			if (ERROR_SEVERITY.test(severity)) errors += entries
			else if (WARNING_SEVERITY.test(severity)) warnings += entries
		}
	}
	return { total: hourly.reduce((sum, entries) => sum + entries, 0), errors, warnings, hourly }
}

/** The services with a workload that reported in the window, most workloads first. */
export const gcpWorkloadCounts = (
	fleet: ReadonlyArray<{
		readonly service: GcpInfraServiceId
		readonly workloads: ReadonlyArray<unknown>
	}>,
): ReadonlyArray<{ readonly service: GcpInfraServiceId; readonly count: number }> =>
	fleet
		.map(({ service, workloads }) => ({ service, count: workloads.length }))
		.filter(({ count }) => count > 0)
		.sort((a, b) => b.count - a.count)

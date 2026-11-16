// Anomaly detector queries
//
// The built-in anomaly detector computes seasonal-naive baselines per series
// in TypeScript from rollup rows. Every query here reads pre-aggregated
// tables only (service_overview_hourly/_minutely, logs_aggregates_hourly,
// error_events_by_time) and returns at most a few thousand rows per org —
// never a raw traces/logs scan.
//
// Baselines read the sealed hourly rows on the hours of day the detector's
// windows straddle; the current observation is a rolling 60-minute window.

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { param } from "@maple-dev/effect-orm/clickhouse"
import { from, fromQuery } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"
import * as T from "@maple-dev/effect-orm/clickhouse"

export interface AnomalyTraceSignalsOpts {
	/** Hour-of-day values (0–23) to include; omitted reads every hour in the time range. */
	readonly hoursOfDay?: readonly number[]
}

const SERVICE_OVERVIEW_P95_MS = CH.rawExpr(
	"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(DurationQuantiles), 2) / 1000000",
	T.float64,
)

/**
 * Hourly entry-point signals per series. Reads `service_overview_hourly`, the twin
 * of the minutely table the current window comes from, so both sides share one
 * entry-point definition and one (unweighted) latency digest.
 */
export function anomalyTraceSignalsQuery(opts: AnomalyTraceSignalsOpts) {
	return from(Datasources.serviceOverviewHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			deploymentEnv: $.DeploymentEnv,
			hour: $.Hour,
			requestCount: CH.sum($.EstimatedSpanCount),
			errorCount: CH.sum($.EstimatedErrorCount),
			p95Ms: SERVICE_OVERVIEW_P95_MS,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			opts.hoursOfDay === undefined ? undefined : CH.toHour($.Hour).in_(...opts.hoursOfDay),
		])
		.groupBy("serviceName", "deploymentEnv", "hour")
		.limit(25000)
		.format("JSON")
}

/** Entry-point signals per series over `[startTime, endTime)`: the detector's rolling current window. */
export function anomalyTraceSignalsWindowQuery() {
	return from(Datasources.serviceOverviewMinutely)
		.select(($) => ({
			serviceName: $.ServiceName,
			deploymentEnv: $.DeploymentEnv,
			requestCount: CH.sum($.EstimatedSpanCount),
			errorCount: CH.sum($.EstimatedErrorCount),
			p95Ms: SERVICE_OVERVIEW_P95_MS,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Minute.gte(utcSecondsParam("startTime")),
			$.Minute.lt(utcSecondsParam("endTime")),
		])
		.groupBy("serviceName", "deploymentEnv")
		.limit(25000)
		.format("JSON")
}

const ERROR_SEVERITIES = ["error", "fatal", "critical"] as const
const WARN_SEVERITIES = ["warn", "warning"] as const

export interface AnomalyLogVolumeOutput {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly hour: DateTime.Utc
	readonly errorLogCount: number
	readonly warnLogCount: number
}

export function anomalyLogVolumeQuery(opts: AnomalyTraceSignalsOpts) {
	return from(Datasources.logsAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			deploymentEnv: $.DeploymentEnv,
			hour: $.Hour,
			errorLogCount: CH.sumIf($.Count, CH.lower_($.SeverityText).in_(...ERROR_SEVERITIES)),
			warnLogCount: CH.sumIf($.Count, CH.lower_($.SeverityText).in_(...WARN_SEVERITIES)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			opts.hoursOfDay === undefined ? undefined : CH.toHour($.Hour).in_(...opts.hoursOfDay),
		])
		.groupBy("serviceName", "deploymentEnv", "hour")
		.limit(25000)
		.format("JSON")
}

export interface AnomalyErrorSpikeCurrentOutput {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly errorLabel: string
	readonly deploymentEnv: string
	readonly count: number
}

export function anomalyErrorSpikeCurrentQuery(opts: { limit?: number }) {
	// Timestamp-leading sort key on error_events_by_time prunes the scan to the
	// 30-minute window (same routing rationale as errorIssuesQuery).
	return from(Datasources.errorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.any_($.ServiceName),
			errorLabel: CH.any_($.ErrorLabel),
			deploymentEnv: $.DeploymentEnv,
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
		])
		.groupBy("fingerprintHash", "deploymentEnv")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// Error fingerprint spike baseline — 7d hourly stats per (fingerprint, env).
// Runs ~once per org per hour; the caller caches the blob in KV.

export interface AnomalyErrorSpikeBaselineOutput {
	readonly fingerprintHash: string
	readonly deploymentEnv: string
	readonly totalCount: number
	readonly medianNonzeroHourly: number
	readonly maxHourly: number
}

export function anomalyErrorSpikeBaselineQuery(opts: { limit?: number }) {
	const hourly = from(Datasources.errorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			deploymentEnv: $.DeploymentEnv,
			h: CH.toStartOfHour($.Timestamp),
			hourCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lt(utcSecondsParam("endTime")),
		])
		.groupBy("fingerprintHash", "deploymentEnv", "h")

	return fromQuery(hourly, "hourly")
		.select(($) => ({
			fingerprintHash: $.fingerprintHash,
			deploymentEnv: $.deploymentEnv,
			totalCount: CH.sum($.hourCount),
			medianNonzeroHourly: CH.quantile(0.5)($.hourCount),
			maxHourly: CH.max_($.hourCount),
		}))
		.groupBy("fingerprintHash", "deploymentEnv")
		.orderBy(["totalCount", "desc"])
		.limit(opts.limit ?? 5000)
		.format("JSON")
}

// Incident timeseries — continuous window for ONE detector series, backing the
// observed-vs-baseline chart on the anomaly detail page. Unlike the detector
// queries above there is no matched-hours filter: the chart wants every bucket
// in the window for a single (service, env) or (fingerprint, env) series.

export interface AnomalyTraceSignalTimeseriesOutput {
	readonly hour: DateTime.Utc
	readonly requestCount: number
	readonly errorCount: number
	readonly p95Ms: number
}

/** Hourly golden-signal buckets for one (service, env) — covers error_rate, latency_p95, throughput. */
export function anomalyTraceSignalTimeseriesQuery() {
	// Must match the detector's series definition: the same entry-point rollup.
	return from(Datasources.serviceOverviewHourly)
		.select(($) => ({
			hour: $.Hour,
			requestCount: CH.sum($.EstimatedSpanCount),
			errorCount: CH.sum($.EstimatedErrorCount),
			p95Ms: SERVICE_OVERVIEW_P95_MS,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(param.string("serviceName")),
			$.DeploymentEnv.eq(param.string("deploymentEnv")),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("hour")
		.orderBy(["hour", "asc"])
		.limit(200)
		.format("JSON")
}

export interface AnomalyLogVolumeTimeseriesOutput {
	readonly hour: DateTime.Utc
	readonly errorLogCount: number
}

/** Hourly error-log volume for one (service, env). */
export function anomalyLogVolumeTimeseriesQuery() {
	return from(Datasources.logsAggregatesHourly)
		.select(($) => ({
			hour: $.Hour,
			errorLogCount: CH.sumIf($.Count, CH.lower_($.SeverityText).in_(...ERROR_SEVERITIES)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(param.string("serviceName")),
			$.DeploymentEnv.eq(param.string("deploymentEnv")),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("hour")
		.orderBy(["hour", "asc"])
		.limit(200)
		.format("JSON")
}

export interface AnomalyErrorSpikeTimeseriesOutput {
	readonly bucket: DateTime.Utc
	readonly count: number
}

/**
 * Fixed-width occurrence buckets for one (fingerprint, env). The anomaly API
 * requests five-minute buckets, then derives the detector's rolling 30-minute
 * window in TypeScript so the chart and five-minute detector tick agree.
 */
export function anomalyErrorSpikeTimeseriesQuery() {
	return (
		// One fingerprint over days: read the table sorted (OrgId, FingerprintHash, Timestamp).
		from(Datasources.errorEvents)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
				count: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
				$.DeploymentEnv.eq(param.string("deploymentEnv")),
				$.Timestamp.gte(utcSecondsParam("startTime")),
				$.Timestamp.lte(utcSecondsParam("endTime")),
			])
			.groupBy("bucket")
			.orderBy(["bucket", "asc"])
			// Seven days at five-minute grain is 2,016 buckets.
			.limit(2500)
			.format("JSON")
	)
}

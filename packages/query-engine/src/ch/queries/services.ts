// ---------------------------------------------------------------------------
// Typed Services Queries
//
// DSL-based query definitions for service overview, releases, apdex, and usage.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type ColumnAccessor } from "../query"
import { unionAll, type CHUnionQuery } from "../union"
import { ServiceOverviewSpans, ServiceUsage } from "../tables"
import { apdexExprs, serviceOverviewWhereConditions } from "./query-helpers"

// ---------------------------------------------------------------------------
// Service overview
// ---------------------------------------------------------------------------

export interface ServiceOverviewOpts {
	environments?: readonly string[]
	commitShas?: readonly string[]
}

export interface ServiceOverviewOutput {
	readonly serviceName: string
	readonly environment: string
	readonly commitSha: string
	readonly throughput: number
	readonly errorCount: number
	readonly spanCount: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly estimatedSpanCount: number
}

export function serviceOverviewQuery(opts: ServiceOverviewOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			serviceName: $.ServiceName,
			environment: $.DeploymentEnv,
			commitSha: $.CommitSha,
			throughput: CH.count(),
			errorCount: CH.countIf($.StatusCode.eq("Error")),
			spanCount: CH.count(),
			p50LatencyMs: CH.quantile(0.5)($.Duration).div(1000000),
			p95LatencyMs: CH.quantile(0.95)($.Duration).div(1000000),
			p99LatencyMs: CH.quantile(0.99)($.Duration).div(1000000),
			// Per-span weighted sum: each row's `SampleRate` is 1.0 for unsampled
			// rows or `1 / acceptanceProbability` for spans carrying a `th:` value.
			// Replaces the broken `sampledSpanCount * dominantWeight` approximation.
			estimatedSpanCount: CH.sum($.SampleRate),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
			opts.commitShas?.length ? CH.inList($.CommitSha, opts.commitShas) : undefined,
		])
		.groupBy("serviceName", "environment", "commitSha")
		.orderBy(["throughput", "desc"])
		.limit(100)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service releases timeline
// ---------------------------------------------------------------------------

export interface ServiceReleasesTimelineOpts {
	serviceName: string
}

export interface ServiceReleasesTimelineOutput {
	readonly bucket: string
	readonly commitSha: string
	readonly count: number
}

export function serviceReleasesTimelineQuery(opts: ServiceReleasesTimelineOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			commitSha: $.CommitSha,
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			$.CommitSha.neq(""),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket", "commitSha")
		.orderBy(["bucket", "asc"])
		.limit(1000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service Apdex time series
// ---------------------------------------------------------------------------

export interface ServiceApdexTimeseriesOpts {
	serviceName: string
	apdexThresholdMs?: number
}

export interface ServiceApdexTimeseriesOutput {
	readonly bucket: string
	readonly totalCount: number
	readonly satisfiedCount: number
	readonly toleratingCount: number
	readonly apdexScore: number
}

export function serviceApdexTimeseriesQuery(opts: ServiceApdexTimeseriesOpts) {
	const thresholdMs = opts.apdexThresholdMs ?? 500

	// Routes through `service_overview_spans` (the entry-point MV) rather than
	// raw `traces`. The MV pre-filters at write time to
	// `SpanKind IN ('Server','Consumer') OR ParentSpanId = ''` — exactly the
	// root-span predicate apdex needs — and pre-extracts `DeploymentEnv` /
	// `CommitSha` from ResourceAttributes. Cuts scan volume by ~20-100x vs.
	// the raw-table path (same pattern `tracesTimeseriesQuery` already uses via
	// `canUseServiceOverviewMv`).
	return from(ServiceOverviewSpans)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			totalCount: CH.count(),
			...apdexExprs($.Duration.div(1000000), thresholdMs),
		}))
		.where(($) => serviceOverviewWhereConditions($, { serviceName: opts.serviceName }))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service usage
// ---------------------------------------------------------------------------

export interface ServiceUsageOpts {
	serviceName?: string
}

export interface ServiceUsageOutput {
	readonly serviceName: string
	readonly totalLogCount: number
	readonly totalLogSizeBytes: number
	readonly totalTraceCount: number
	readonly totalTraceSizeBytes: number
	readonly totalSumMetricCount: number
	readonly totalSumMetricSizeBytes: number
	readonly totalGaugeMetricCount: number
	readonly totalGaugeMetricSizeBytes: number
	readonly totalHistogramMetricCount: number
	readonly totalHistogramMetricSizeBytes: number
	readonly totalExpHistogramMetricCount: number
	readonly totalExpHistogramMetricSizeBytes: number
	readonly totalSizeBytes: number
}

export function serviceUsageQuery(opts: ServiceUsageOpts) {
	return from(ServiceUsage)
		.select(($) => ({
			serviceName: $.ServiceName,
			totalLogCount: CH.sum($.LogCount),
			totalLogSizeBytes: CH.sum($.LogSizeBytes),
			totalTraceCount: CH.sum($.TraceCount),
			totalTraceSizeBytes: CH.sum($.TraceSizeBytes),
			totalSumMetricCount: CH.sum($.SumMetricCount),
			totalSumMetricSizeBytes: CH.sum($.SumMetricSizeBytes),
			totalGaugeMetricCount: CH.sum($.GaugeMetricCount),
			totalGaugeMetricSizeBytes: CH.sum($.GaugeMetricSizeBytes),
			totalHistogramMetricCount: CH.sum($.HistogramMetricCount),
			totalHistogramMetricSizeBytes: CH.sum($.HistogramMetricSizeBytes),
			totalExpHistogramMetricCount: CH.sum($.ExpHistogramMetricCount),
			totalExpHistogramMetricSizeBytes: CH.sum($.ExpHistogramMetricSizeBytes),
			totalSizeBytes: CH.sum($.LogSizeBytes)
				.add(CH.sum($.TraceSizeBytes))
				.add(CH.sum($.SumMetricSizeBytes))
				.add(CH.sum($.GaugeMetricSizeBytes))
				.add(CH.sum($.HistogramMetricSizeBytes))
				.add(CH.sum($.ExpHistogramMetricSizeBytes)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// `service_usage` is keyed on top-of-hour `Hour`. Comparing to the raw
			// `startTime` / `endTime` literals misses every sub-hour window — e.g.
			// "last 15 min" at 22:23–22:38 returns no rows because `Hour=22:00 <
			// 22:23`. Snap both bounds to their hour floor so any hour overlapping
			// the requested window contributes. The cards over-report toward the
			// edges (they show the full enclosing hour, not just the partial
			// window) which is the only sensible answer when the MV is hourly.
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("startTime")))),
			$.Hour.lte(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("serviceName")
		.orderBy(["totalSizeBytes", "desc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Services facets (UNION ALL — environment + commit_sha facets)
// ---------------------------------------------------------------------------

export interface ServicesFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

export function servicesFacetsQuery(): CHUnionQuery<ServicesFacetsOutput> {
	const baseWhere = (
		$: ColumnAccessor<typeof ServiceOverviewSpans.columns>,
	): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
	]

	const envQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.DeploymentEnv,
			count: CH.count(),
			facetType: CH.lit("environment"),
		}))
		.where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const commitQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.CommitSha,
			count: CH.count(),
			facetType: CH.lit("commit_sha"),
		}))
		.where(($) => [...baseWhere($), $.CommitSha.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	// Service-name facet — reused by `useDefaultPreset` on the dashboard route to
	// detect the all-demo case without firing a separate `serviceOverview` query.
	// Same MV scan as the env / commit branches; effectively free.
	const serviceQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.ServiceName,
			count: CH.count(),
			facetType: CH.lit("service"),
		}))
		.where(($) => [...baseWhere($), $.ServiceName.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	return unionAll(envQuery, commitQuery, serviceQuery).format("JSON")
}

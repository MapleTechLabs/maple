// Tinybird Endpoint Types
//
// Type-only definitions for query results. The actual SQL queries are compiled
// by @maple/query-engine. These types exist solely for consumers that import
// output shapes (apps/web, observability layer).

// list_traces

export interface ListTracesOutput {
	readonly traceId: string
	readonly startTime: string
	readonly endTime: string
	readonly durationMicros: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly rootSpanId: string
	readonly rootSpanKind: string
	readonly rootSpanStatusCode: string
	readonly rootSpanStatusMessage: string
	readonly rootHttpMethod: string
	readonly rootHttpRoute: string
	readonly rootHttpStatusCode: string
	/** The root span's projected attribute map, JSON-encoded. */
	readonly rootSpanAttributes: string
	/** Root resource's deployment environment and service.version, '' when unset. */
	readonly rootDeploymentEnv: string
	readonly rootServiceVersion: string
	readonly hasError: number
}

// span_hierarchy

export interface SpanHierarchyOutput {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	/** The stored SpanName; `spanName` is the HTTP display rewrite. */
	readonly rawSpanName: string
	readonly serviceName: string
	readonly spanKind: string
	readonly durationMs: number
	readonly startTime: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly spanAttributes: string
	readonly resourceAttributes: string
	readonly relationship: string
}

// list_logs

export interface ListLogsOutput {
	readonly timestamp: string
	/** `timestamp` with its nanoseconds, for cursors and log keys. */
	readonly exactTimestamp: string
	readonly severityText: string
	readonly severityNumber: number
	readonly serviceName: string
	readonly body: string
	readonly traceId: string
	readonly spanId: string
	/** Stable per-row identity (`hex(MD5(tuple(…)))`), the list's pagination cursor. */
	readonly recordIdentity: string
	readonly logAttributes: string
	readonly resourceAttributes: string
}

// logs_count

export interface LogsCountOutput {
	readonly total: number
}

// logs_facets

export interface LogsFacetsOutput {
	readonly severityText: string
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly namespace: string
	readonly count: number
	readonly facetType: string
}

// error_rate_by_service

export interface ErrorRateByServiceOutput {
	readonly serviceName: string
	readonly totalLogs: number
	readonly errorLogs: number
	readonly errorRate: number
}

// get_service_usage

export interface GetServiceUsageOutput {
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

// list_metrics

export interface ListMetricsOutput {
	readonly metricName: string
	readonly metricType: string
	readonly serviceName: string
	readonly metricDescription: string
	readonly metricUnit: string
	readonly dataPointCount: number
	readonly firstSeen: string
	readonly lastSeen: string
	readonly isMonotonic: boolean | number
}

// metrics_summary

export interface MetricsSummaryOutput {
	readonly metricType: string
	readonly metricCount: number
	readonly dataPointCount: number
}

// traces_facets

export interface TracesFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

// traces_duration_stats

export interface TracesDurationStatsOutput {
	readonly minDurationMs: number
	readonly maxDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
}

// service_overview

/**
 * One commit's slice of a (service, environment) row: `[sha, spanCount,
 * errorCount, firstSeen]`. A positional tuple because that is how ClickHouse
 * serializes `tuple(...)` in `FORMAT JSON` — a nested array, not an object.
 */
export type ServiceCommitTuple = readonly [
	commitSha: string,
	spanCount: number,
	errorCount: number,
	firstSeen: string,
]

export interface ServiceOverviewOutput {
	readonly serviceName: string
	/** The dominant namespace; the metrics beside it cover every namespace variant. */
	readonly serviceNamespace: string
	readonly environment: string
	readonly throughput: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly spanCount: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly estimatedSpanCount: number
	readonly firstSeen: string
	/**
	 * Per-commit breakdown, sorted by span count descending and capped. Replaces
	 * the former one-row-per-commit shape: rows are now collapsed to the
	 * (service, environment) grain the UI renders, with quantiles merged in
	 * ClickHouse rather than averaged in the client.
	 */
	readonly commits: readonly ServiceCommitTuple[]
}

// services_facets

export interface ServicesFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

// service_releases_timeline

export interface ServiceReleasesTimelineOutput {
	readonly bucket: string
	readonly commitSha: string
	readonly count: number
	readonly errorCount: number
}

// errors_by_type

export interface ErrorsByTypeOutput {
	readonly fingerprintHash: string
	readonly errorLabel: string
	readonly sampleMessage: string
	readonly count: number
	readonly affectedServicesCount: number
	readonly firstSeen: string
	readonly lastSeen: string
}

// errors_timeseries

export interface ErrorsTimeseriesOutput {
	readonly bucket: string
	readonly count: number
}

// error_detail_traces

export interface ErrorDetailTracesOutput {
	readonly traceId: string
	readonly startTime: string
	readonly durationMicros: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly errorMessage: string
	readonly errorSpanId: string
	readonly errorSpanName: string
	readonly errorServiceName: string
	readonly errorModel: string
	readonly errorToolName: string
	readonly errorHttpMethod: string
	readonly errorHttpRoute: string
	readonly errorHttpStatus: string
	readonly errorQueryContext: string
	readonly errorType: string
	readonly errorLabel: string
	readonly exceptionType: string
	readonly exceptionMessage: string
}

// errors_facets

export interface ErrorsFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

// errors_summary

export interface ErrorsSummaryOutput {
	readonly totalErrors: number
	readonly totalSpans: number
	readonly errorRate: number
	readonly affectedServicesCount: number
	readonly affectedTracesCount: number
}

// service_apdex_time_series

export interface ServiceApdexTimeSeriesOutput {
	readonly bucket: string
	readonly totalCount: number
	readonly satisfiedCount: number
	readonly toleratingCount: number
	readonly apdexScore: number
}

// service_dependencies

export interface ServiceDependenciesOutput {
	readonly sourceService: string
	readonly targetService: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	/** Slowest call in the window, not a percentile — the edge rollup stores a max. */
	readonly maxDurationMs: number
	readonly estimatedSpanCount: number
}

// Attribute keys & values

export interface SpanAttributeKeysOutput {
	readonly attributeKey: string
	readonly usageCount: number
}

export interface SpanAttributeValuesOutput {
	readonly attributeValue: string
	readonly usageCount: number
}

export interface ResourceAttributeValuesOutput {
	readonly attributeValue: string
	readonly usageCount: number
}

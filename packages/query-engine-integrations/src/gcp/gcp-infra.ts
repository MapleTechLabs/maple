// Infrastructure -> Google Cloud page (/infra/gcp)
//
// Reads the `gcp.*` metrics the Google Cloud poller stores, one point per minute and series.
// Counters are delta sums in `metrics_sum`; gauges and percentiles (one row per `quantile`) are in
// `metrics_gauge`. Nothing else writes these metric names, so they scope a query on their own.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromUnion, param, unionAll, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import {
	GCP_INFRA_ROW_LIMIT,
	GCP_INFRA_SERVICE_IDS,
	GCP_INFRA_SERVICES,
	gcpInfraMetrics,
	type GcpInfraServiceId,
} from "@maple/domain/gcp-infra"
import {
	MetricCatalog,
	MetricsGauge,
	MetricsSum,
	orgIdParam,
	utcSecondsParam,
} from "@maple/query-engine/ch/tables"

/** Both metrics tables declare the columns read here alike. */
type MetricsAccessor = ColumnAccessor<typeof MetricsSum.columns> | ColumnAccessor<typeof MetricsGauge.columns>

/**
 * Every curated metric of one service: one row per workload (`keys`, the values of the service's
 * `identity`), metric and `label` (the metric's label value or quantile, empty without one).
 * `total` sums the window's points and `samples` counts them: a counter reads as `total`, a
 * gauge or percentile as the mean `total / samples`.
 */
export function gcpInfraMetricsSQL(service: GcpInfraServiceId) {
	const metrics = gcpInfraMetrics(service)
	// A metric keeps at most one label, so joining the candidates yields the one that is set.
	const labels = ["quantile", ...new Set(metrics.flatMap((metric) => metric.labels))]
	const point = ($: MetricsAccessor) => ({
		keys: CH.arrayOf(
			...GCP_INFRA_SERVICES[service].identity.map(([, attribute]) =>
				$.ResourceAttributes.get(attribute),
			),
		),
		metric: $.MetricName,
		label: CH.arrayStringConcat(
			labels.map((label) => $.Attributes.get(label)),
			"",
		),
		value: $.Value,
	})
	const inWindow = ($: MetricsAccessor, sums: boolean) => [
		$.OrgId.eq(orgIdParam),
		CH.inList(
			$.MetricName,
			metrics.filter((metric) => (metric.kind === "sum") === sums).map((metric) => metric.name),
		),
		$.TimeUnix.gte(param.dateTime("startTime")),
		$.TimeUnix.lte(param.dateTime("endTime")),
	]
	return fromUnion(
		unionAll(
			from(MetricsSum)
				.select(point)
				.where(($) => inWindow($, true)),
			from(MetricsGauge)
				.select(point)
				.where(($) => inWindow($, false)),
		),
		"points",
	)
		.select(($) => ({
			keys: $.keys,
			metric: $.metric,
			label: $.label,
			total: CH.sum($.value),
			samples: CH.count(),
		}))
		.groupBy("keys", "metric", "label")
		.orderBy(["keys", "asc"], ["metric", "asc"], ["label", "asc"])
		.limit(GCP_INFRA_ROW_LIMIT)
		.format("JSON")
}

/** Which of the page's metrics reported in the window, from the hourly `metric_catalog` rollup. */
export function gcpInfraPresenceSQL() {
	return from(MetricCatalog)
		.select(($) => ({ metric: $.MetricName }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.inList(
				$.MetricName,
				GCP_INFRA_SERVICE_IDS.flatMap((service) =>
					gcpInfraMetrics(service).map((metric) => metric.name),
				),
			),
			// `Hour` is hour-truncated: floor the start so a mid-hour range keeps its first bucket.
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(param.dateTime("startTime")), 3600)),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("metric")
		.format("JSON")
}

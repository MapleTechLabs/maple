// Infrastructure -> AWS pages (/infra/aws)
//
// Reads the `aws.*` metrics the CloudWatch metric stream sends: a statistic's mean is a gauge in
// `metrics_gauge`, its sum a delta counter in `metrics_sum`. Dimensions are point attributes;
// region and account are resource attributes.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromUnion, param, unionAll, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import {
	AWS_INFRA_KIND_IDS,
	AWS_INFRA_KINDS,
	AWS_INFRA_RESOURCE_KEYS,
	AWS_INFRA_RESOURCE_LIMIT,
	AWS_INFRA_ROW_LIMIT,
	awsDimensionAttribute,
	type AwsInfraKindId,
	type AwsInfraMetric,
} from "@maple/domain/aws-infra"
import {
	MetricCatalog,
	MetricsGauge,
	MetricsSum,
	orgIdParam,
	utcSecondsParam,
} from "@maple/query-engine/ch/tables"

/** Both metrics tables declare the columns read here alike. */
type MetricsAccessor = ColumnAccessor<typeof MetricsSum.columns> | ColumnAccessor<typeof MetricsGauge.columns>

/** A row's identity values, then its region and account: `AWS_INFRA_RESOURCE_KEYS`. */
const resourceKeys = ($: MetricsAccessor, kind: AwsInfraKindId) =>
	CH.arrayOf(
		...AWS_INFRA_KINDS[kind].identity.map(([, dimension]) =>
			$.Attributes.get(awsDimensionAttribute(dimension)),
		),
		...AWS_INFRA_RESOURCE_KEYS.map((attribute) => $.ResourceAttributes.get(attribute)),
	)

/** The kind's points in the window, from one table, at exactly the kind's dimension set. */
const kindPoints = (
	$: MetricsAccessor,
	kind: AwsInfraKindId,
	table: AwsInfraMetric["table"],
	metrics: ReadonlyArray<AwsInfraMetric>,
) =>
	[
		$.OrgId.eq(orgIdParam),
		CH.inList($.MetricName, [
			...new Set(metrics.filter((metric) => metric.table === table).map((metric) => metric.name)),
		]),
		$.TimeUnix.gte(param.dateTime("startTime")),
		$.TimeUnix.lte(param.dateTime("endTime")),
		...AWS_INFRA_KINDS[kind].identity.map(([, dimension]) =>
			$.Attributes.get(awsDimensionAttribute(dimension)).neq(""),
		),
		...AWS_INFRA_KINDS[kind].excluded.map((dimension) =>
			$.Attributes.get(awsDimensionAttribute(dimension)).eq(""),
		),
	] as const

/**
 * Every metric of one kind: one row per resource (`keys`) and metric. `total` sums the window's
 * points and `samples` counts them: a sum reads as `total`, a gauge as the mean `total / samples`.
 * `peak` is the highest point, `lastSeen` the newest.
 */
export function awsInfraMetricsSQL(kind: AwsInfraKindId) {
	const metrics = AWS_INFRA_KINDS[kind].metrics
	const point = ($: MetricsAccessor) => ({
		keys: resourceKeys($, kind),
		t: $.TimeUnix,
		metric: $.MetricName,
		value: $.Value,
	})
	return fromUnion(
		unionAll(
			from(MetricsSum)
				.select(point)
				.where(($) => kindPoints($, kind, "sum", metrics)),
			from(MetricsGauge)
				.select(point)
				.where(($) => kindPoints($, kind, "gauge", metrics)),
		),
		"points",
	)
		.select(($) => ({
			keys: $.keys,
			metric: $.metric,
			total: CH.sum($.value),
			samples: CH.count(),
			peak: CH.max_($.value),
			lastSeen: CH.max_($.t),
		}))
		.groupBy("keys", "metric")
		.orderBy(["keys", "asc"], ["metric", "asc"])
		.limit(AWS_INFRA_RESOURCE_LIMIT * metrics.length)
		.format("JSON")
}

/** How many buckets a window spans, counting the partial ones at either end. */
export const awsInfraBucketCount = (startTime: string, endTime: string, bucketSeconds: number) => {
	const seconds =
		(Date.parse(`${endTime.replace(" ", "T")}Z`) - Date.parse(`${startTime.replace(" ", "T")}Z`)) / 1000
	return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / bucketSeconds) + 1 : 1
}

/**
 * Each resource's sparkline metric over time: one row per resource, bucket and metric. The limit
 * covers `buckets` rows for every resource `awsInfraMetricsSQL` reads, so no row loses its line.
 */
export function awsInfraSparklinesSQL(kind: AwsInfraKindId, buckets: number) {
	const definition = AWS_INFRA_KINDS[kind]
	const metrics = definition.metrics.filter((metric) => metric.key === definition.sparkline)
	const point = ($: MetricsAccessor) => ({
		keys: resourceKeys($, kind),
		t: $.TimeUnix,
		metric: $.MetricName,
		value: $.Value,
	})
	return fromUnion(
		unionAll(
			from(MetricsSum)
				.select(point)
				.where(($) => kindPoints($, kind, "sum", metrics)),
			from(MetricsGauge)
				.select(point)
				.where(($) => kindPoints($, kind, "gauge", metrics)),
		),
		"points",
	)
		.select(($) => ({
			keys: $.keys,
			bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
			metric: $.metric,
			total: CH.sum($.value),
			samples: CH.count(),
		}))
		.groupBy("keys", "bucket", "metric")
		.orderBy(["keys", "asc"], ["bucket", "asc"], ["metric", "asc"])
		.limit(AWS_INFRA_RESOURCE_LIMIT * Math.max(1, buckets))
		.format("JSON")
}

/**
 * Every metric of one resource over time: one row per bucket and metric, read like a row of
 * `awsInfraMetricsSQL`. `keys` are the resource's, as that query returns them.
 */
export function awsInfraTimeseriesSQL(kind: AwsInfraKindId, keys: ReadonlyArray<string>) {
	const definition = AWS_INFRA_KINDS[kind]
	const point = ($: MetricsAccessor) => ({ t: $.TimeUnix, metric: $.MetricName, value: $.Value })
	const identity = definition.identity.length
	const ofResource = ($: MetricsAccessor, table: AwsInfraMetric["table"]) =>
		[
			...kindPoints($, kind, table, definition.metrics),
			...definition.identity.map(([, dimension], index) =>
				$.Attributes.get(awsDimensionAttribute(dimension)).eq(keys[index] ?? ""),
			),
			...AWS_INFRA_RESOURCE_KEYS.map((attribute, index) =>
				$.ResourceAttributes.get(attribute).eq(keys[identity + index] ?? ""),
			),
		] as const
	return fromUnion(
		unionAll(
			from(MetricsSum)
				.select(point)
				.where(($) => ofResource($, "sum")),
			from(MetricsGauge)
				.select(point)
				.where(($) => ofResource($, "gauge")),
		),
		"points",
	)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
			metric: $.metric,
			total: CH.sum($.value),
			samples: CH.count(),
		}))
		.groupBy("bucket", "metric")
		.orderBy(["bucket", "asc"], ["metric", "asc"])
		.limit(AWS_INFRA_ROW_LIMIT)
		.format("JSON")
}

/** Which of the page's metrics reported in the window, from the hourly `metric_catalog` rollup. */
export function awsInfraPresenceSQL() {
	return from(MetricCatalog)
		.select(($) => ({ metric: $.MetricName }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.inList($.MetricName, [
				...new Set(
					AWS_INFRA_KIND_IDS.flatMap((kind) => AWS_INFRA_KINDS[kind].metrics.map((m) => m.name)),
				),
			]),
			// `Hour` is hour-truncated: floor the start so a mid-hour range keeps its first bucket.
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(utcSecondsParam("startTime")), 3600)),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("metric")
		.format("JSON")
}

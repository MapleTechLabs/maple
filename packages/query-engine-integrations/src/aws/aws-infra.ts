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
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "@maple/query-engine/ch/tables"
import { edgeCondition, hourGrain, utcInteriorConditions } from "@maple/query-engine/ch/rollup-splice"
import { Array as Arr, String as Str } from "effect"

/** Both metrics tables declare the columns read here alike. */
type MetricsAccessor =
	| ColumnAccessor<typeof Datasources.metricsSum.columns>
	| ColumnAccessor<typeof Datasources.metricsGauge.columns>

/** A row's identity values, then its region and account: `AWS_INFRA_RESOURCE_KEYS`. */
const resourceKeys = (
	kind: AwsInfraKindId,
	attribute: (key: string) => CH.Expr<string>,
	resource: Readonly<Record<(typeof AWS_INFRA_RESOURCE_KEYS)[number], CH.Expr<string>>>,
) =>
	CH.arrayOf(
		...Arr.map(AWS_INFRA_KINDS[kind].identity, ([, dimension]) =>
			attribute(awsDimensionAttribute(dimension)),
		),
		...Arr.map(AWS_INFRA_RESOURCE_KEYS, (key) => resource[key]),
	)

/** `resourceKeys` of a raw point: region and account from its resource attributes. */
const rawResourceKeys = ($: MetricsAccessor, kind: AwsInfraKindId) =>
	resourceKeys(kind, (key) => $.Attributes.get(key), {
		"cloud.region": $.ResourceAttributes.get("cloud.region"),
		"cloud.account.id": $.ResourceAttributes.get("cloud.account.id"),
	})

/** The kind's metric names stored in one table. */
const metricNames = (metrics: ReadonlyArray<AwsInfraMetric>, table: AwsInfraMetric["table"]) => [
	...new Set(
		Arr.map(
			Arr.filter(metrics, (metric) => metric.table === table),
			(metric) => metric.name,
		),
	),
]

/** Exactly the kind's dimension set: its identity dimensions present, its excluded ones absent. */
const dimensionSet = (attribute: (key: string) => CH.Expr<string>, kind: AwsInfraKindId) => [
	...Arr.map(AWS_INFRA_KINDS[kind].identity, ([, dimension]) =>
		attribute(awsDimensionAttribute(dimension)).neq(""),
	),
	...Arr.map(AWS_INFRA_KINDS[kind].excluded, (dimension) =>
		attribute(awsDimensionAttribute(dimension)).eq(""),
	),
]

/** The kind's points in the window, from one table, at exactly the kind's dimension set. */
const kindPoints = (
	$: MetricsAccessor,
	kind: AwsInfraKindId,
	table: AwsInfraMetric["table"],
	metrics: ReadonlyArray<AwsInfraMetric>,
) =>
	[
		$.OrgId.eq(orgIdParam),
		CH.inList($.MetricName, metricNames(metrics, table)),
		// The start floored to the second, as the splice floors it: with the exact bound, a start
		// just past an hour would drop that hour's first points from raw but keep them in the rollup.
		CH.rawCond(`TimeUnix >= ${hourGrain.startDt}`),
		$.TimeUnix.lte(param.dateTime("endTime")),
		...dimensionSet((key) => $.Attributes.get(key), kind),
	] as const

/**
 * Where `awsInfraMetricsSQL` reads: whole hours from `aws_metrics_hourly` and the partial hours at
 * either end from raw points, or raw points only, for a cluster without migration 0066.
 */
export type AwsMetricsTier = "hourly" | "raw"

/** One table's raw points per resource and metric; on the hourly tier only the hours the rollup leaves out. */
const rawTotals = (kind: AwsInfraKindId, table: AwsInfraMetric["table"], tier: AwsMetricsTier) =>
	from(table === "sum" ? Datasources.metricsSum : Datasources.metricsGauge)
		.select(($) => ({
			keys: rawResourceKeys($, kind),
			metric: $.MetricName,
			total: CH.sum($.Value),
			samples: CH.count(),
			peak: CH.max_($.Value),
			lastSeen: CH.max_(CH.toDateTime($.TimeUnix)),
		}))
		.where(($) => [
			...kindPoints($, kind, table, AWS_INFRA_KINDS[kind].metrics),
			CH.whenTrue(tier === "hourly", () => edgeCondition("TimeUnix")),
		])
		.groupBy("keys", "metric")

/** The same per resource and metric from the rollup's whole hours, at the kind's exact dimension set. */
const hourlyTotals = (kind: AwsInfraKindId, table: AwsInfraMetric["table"]) =>
	from(Datasources.awsMetricsHourly)
		.select(($) => ({
			keys: resourceKeys(kind, (key) => $.Attributes.get(key), {
				"cloud.region": $.CloudRegion,
				"cloud.account.id": $.CloudAccountId,
			}),
			metric: $.MetricName,
			total: CH.sum($.Total),
			samples: CH.sum($.Samples),
			peak: CH.max_($.Peak),
			lastSeen: CH.max_($.LastSeen),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricType.eq(table),
			CH.inList($.MetricName, metricNames(AWS_INFRA_KINDS[kind].metrics, table)),
			...utcInteriorConditions($.Hour),
			...dimensionSet((key) => $.Attributes.get(key), kind),
		])
		.groupBy("keys", "metric")

/**
 * Every metric of one kind: one row per resource (`keys`) and metric. `total` sums the window's
 * points and `samples` counts them: a sum reads as `total`, a gauge as the mean `total / samples`.
 * `peak` is the highest point, `lastSeen` the newest.
 */
export function awsInfraMetricsSQL(kind: AwsInfraKindId, tier: AwsMetricsTier) {
	return fromUnion(
		tier === "hourly"
			? unionAll(
					rawTotals(kind, "sum", tier),
					hourlyTotals(kind, "sum"),
					rawTotals(kind, "gauge", tier),
					hourlyTotals(kind, "gauge"),
				)
			: unionAll(rawTotals(kind, "sum", tier), rawTotals(kind, "gauge", tier)),
		"points",
	)
		.select(($) => ({
			keys: $.keys,
			metric: $.metric,
			total: CH.sum($.total),
			samples: CH.sum($.samples),
			peak: CH.max_($.peak),
			lastSeen: CH.max_($.lastSeen),
		}))
		.groupBy("keys", "metric")
		.orderBy(["keys", "asc"], ["metric", "asc"])
		.limit(AWS_INFRA_RESOURCE_LIMIT * AWS_INFRA_KINDS[kind].metrics.length)
		.format("JSON")
}

/** How many buckets a window spans, counting the partial ones at either end. */
export const awsInfraBucketCount = (startTime: string, endTime: string, bucketSeconds: number) => {
	const seconds =
		(Date.parse(`${Str.replace(" ", "T")(endTime)}Z`) -
			Date.parse(`${Str.replace(" ", "T")(startTime)}Z`)) /
		1000
	return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / bucketSeconds) + 1 : 1
}

/**
 * Each resource's sparkline metric over time: one row per resource, bucket and metric. The limit
 * covers `buckets` rows for every resource `awsInfraMetricsSQL` reads, so no row loses its line.
 */
export function awsInfraSparklinesSQL(kind: AwsInfraKindId, buckets: number) {
	const definition = AWS_INFRA_KINDS[kind]
	const metrics = Arr.filter(definition.metrics, (metric) => metric.key === definition.sparkline)
	const point = ($: MetricsAccessor) => ({
		keys: rawResourceKeys($, kind),
		t: $.TimeUnix,
		metric: $.MetricName,
		value: $.Value,
	})
	return fromUnion(
		unionAll(
			from(Datasources.metricsSum)
				.select(point)
				.where(($) => kindPoints($, kind, "sum", metrics)),
			from(Datasources.metricsGauge)
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
			...Arr.map(definition.identity, ([, dimension], index) =>
				$.Attributes.get(awsDimensionAttribute(dimension)).eq(keys[index] ?? ""),
			),
			...Arr.map(AWS_INFRA_RESOURCE_KEYS, (attribute, index) =>
				$.ResourceAttributes.get(attribute).eq(keys[identity + index] ?? ""),
			),
		] as const
	return fromUnion(
		unionAll(
			from(Datasources.metricsSum)
				.select(point)
				.where(($) => ofResource($, "sum")),
			from(Datasources.metricsGauge)
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
	return from(Datasources.metricCatalog)
		.select(($) => ({ metric: $.MetricName }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.inList($.MetricName, [
				...new Set(
					Arr.flatMap(AWS_INFRA_KIND_IDS, (kind) =>
						Arr.map(AWS_INFRA_KINDS[kind].metrics, (m) => m.name),
					),
				),
			]),
			// `Hour` is hour-truncated: floor the start so a mid-hour range keeps its first bucket.
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(utcSecondsParam("startTime")), 3600)),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("metric")
		.format("JSON")
}

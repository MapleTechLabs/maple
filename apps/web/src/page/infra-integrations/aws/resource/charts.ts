import { AWS_INFRA_KINDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import { Array as Arr } from "effect"
import type { MetricChart } from "../../kit/metric-charts"
import type { BucketPoint } from "../data"

// The resource page's charts and tiles, read off its timeseries.

/** One bucket: each metric's mean for a gauge, its sum for a counter. */
export type BucketRow = Readonly<{ bucket: string; values: Readonly<Record<string, number>> }>

export const bucketRows = (
	kind: AwsInfraKindId,
	points: ReadonlyArray<BucketPoint>,
): ReadonlyArray<BucketRow> => {
	const metrics = new Map(AWS_INFRA_KINDS[kind].metrics.map((metric) => [metric.name, metric]))
	return Object.entries(Arr.groupBy(points, (point) => point.bucket))
		.map(([bucket, group]) => ({
			bucket,
			values: Object.fromEntries(
				group.flatMap((point) => {
					const metric = metrics.get(point.metric)
					if (metric === undefined) return []
					const value =
						metric.table === "sum"
							? point.total
							: point.samples > 0
								? point.total / point.samples
								: 0
					return [[metric.key, value] as const]
				}),
			),
		}))
		.toSorted((a, b) => a.bucket.localeCompare(b.bucket))
}

const pick =
	(key: string, scale = 1) =>
	(row: BucketRow): number | null => {
		const value = row.values[key]
		return value === undefined ? null : value * scale
	}

/** CloudWatch percents as shares of 1, which the percent unit formats. */
const PERCENT = 1 / 100

export const CHARTS = {
	ecs: [
		{ id: "CPU", unit: "percent", series: [["CPU", pick("cpu", PERCENT)]] },
		{ id: "Memory", unit: "percent", series: [["Memory", pick("memory", PERCENT)]] },
	],
	ec2: [
		{ id: "CPU", unit: "percent", series: [["CPU", pick("cpu", PERCENT)]] },
		{
			id: "Network",
			unit: "bytes",
			series: [
				["In", pick("networkIn")],
				["Out", pick("networkOut")],
			],
		},
		{ id: "Status checks failed", unit: "count", series: [["Failed", pick("statusFailed")]] },
	],
	loadBalancers: [
		{ id: "Requests", unit: "count", series: [["Requests", pick("requests")]] },
		{
			id: "5xx responses",
			unit: "count",
			series: [
				["Target 5xx", pick("target5xx")],
				["Load balancer 5xx", pick("elb5xx")],
			],
		},
		{
			id: "Target response time",
			unit: "milliseconds",
			series: [["Average", pick("responseTime", 1000)]],
		},
	],
	rds: [
		{ id: "CPU", unit: "percent", series: [["CPU", pick("cpu", PERCENT)]] },
		{ id: "Connections", unit: "count", series: [["Connections", pick("connections")]] },
		{ id: "Free storage", unit: "bytes", series: [["Free storage", pick("freeStorage")]] },
		{ id: "Free memory", unit: "bytes", series: [["Free memory", pick("freeMemory")]] },
	],
	lambda: [
		{
			id: "Invocations",
			unit: "count",
			series: [
				["Invocations", pick("invocations")],
				["Errors", pick("errors")],
			],
		},
		{ id: "Throttles", unit: "count", series: [["Throttles", pick("throttles")]] },
		{ id: "Duration", unit: "milliseconds", series: [["Average", pick("duration")]] },
	],
	sqs: [
		{ id: "Visible messages", unit: "count", series: [["Visible", pick("visible")]] },
		{ id: "Oldest message age", unit: "seconds", series: [["Age", pick("oldestAge")]] },
		{ id: "Messages sent", unit: "count", series: [["Sent", pick("sent")]] },
	],
} satisfies Record<AwsInfraKindId, ReadonlyArray<MetricChart<BucketRow>>>

export const chartIds = (kind: AwsInfraKindId) => CHARTS[kind].map((chart) => chart.id)

/** A metric over the window: the mean of a gauge's buckets or the sum of a counter's, its peak, and its trend. */
export type Figure = Readonly<{ value: number; peak: number; trend: ReadonlyArray<number> }>

export const figureOf = (
	kind: AwsInfraKindId,
	rows: ReadonlyArray<BucketRow>,
	key: string,
): Figure | null => {
	const metric = AWS_INFRA_KINDS[kind].metrics.find((entry) => entry.key === key)
	const values = rows.flatMap((row) => {
		const value = row.values[key]
		return value === undefined ? [] : [value]
	})
	if (metric === undefined || values.length === 0) return null
	const total = values.reduce((sum, value) => sum + value, 0)
	return {
		value: metric.table === "sum" ? total : total / values.length,
		peak: Math.max(...values),
		trend: values.slice(-28),
	}
}

// A Google Cloud workload's page: which charts each service shows, and how the buckets of the
// timeseries query become their rows. Pure (no React, no atoms).

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"

import type { ChartUnit } from "../chart-utils"
import {
	failedShare,
	gcpMetricReader,
	serverErrors,
	unhealthy,
	type GcpMetricReader,
	type GcpMetricValue,
} from "./tabs"

/** A row of the timeseries query: see `gcpInfraTimeseriesSQL`. */
export interface GcpBucketPoint extends GcpMetricValue {
	readonly bucket: string
}

export interface GcpSeries {
	readonly name: string
	/** The metric it reads, which is where the chart's link into the metrics explorer opens. */
	readonly metric: string
	readonly value: (read: GcpMetricReader, bucketSeconds: number) => number | undefined
}

interface GcpChartBase {
	readonly title: string
	/** Why a workload may never report it, shown in place of an empty plot. */
	readonly note?: string
}

export type GcpChart =
	| (GcpChartBase & {
			readonly kind: "lines"
			readonly unit: ChartUnit
			readonly series: ReadonlyArray<GcpSeries>
			/** Draws the 80% rule: for a share of a limit or of capacity. */
			readonly threshold?: boolean
	  })
	/** A counter stacked by its label value, as counts per bucket. */
	| (GcpChartBase & { readonly kind: "classes"; readonly metric: string })

const scaled = (value: number | undefined, scale: number) => (value === undefined ? undefined : value * scale)

/** A gauge's or percentile's mean over the bucket. */
const mean = (name: string, metric: string, label?: string, scale = 1): GcpSeries => ({
	name,
	metric,
	value: (read) => scaled(read.mean(metric, label), scale),
})

/** A counter per second. The poller stores no zero deltas, so a quiet bucket reads as zero. */
const rate = (name: string, metric: string): GcpSeries => ({
	name,
	metric,
	value: (read, bucketSeconds) => read.total(metric) / bucketSeconds,
})

/** A counter's sum over the bucket. */
const count = (name: string, metric: string): GcpSeries => ({
	name,
	metric,
	value: (read) => read.total(metric),
})

const percentiles = (metric: string, scale = 1): ReadonlyArray<GcpSeries> => [
	mean("p50", metric, "0.5", scale),
	mean("p95", metric, "0.95", scale),
	mean("p99", metric, "0.99", scale),
]

const lines = (
	title: string,
	unit: ChartUnit,
	series: ReadonlyArray<GcpSeries>,
	options: { readonly threshold?: boolean; readonly note?: string } = {},
): GcpChart => ({ kind: "lines", title, unit, series, ...options })

const classes = (title: string, metric: string, note?: string): GcpChart => ({
	kind: "classes",
	title,
	metric,
	note,
})

const OF_LIMIT = { threshold: true } as const

const RUN = "gcp.run"
const FUNCTION = "gcp.cloudfunctions.function"
const CONTAINER = "gcp.kubernetes.container"
const NODE = "gcp.kubernetes.node"
const INSTANCE = "gcp.compute.instance"
const DATABASE = "gcp.cloudsql.database"
const SUBSCRIPTION = "gcp.pubsub.subscription"
const HTTPS = "gcp.loadbalancing.https"

const PUSH_ONLY = "Push subscriptions only."

export const GCP_INFRA_CHARTS: Record<GcpInfraServiceId, ReadonlyArray<GcpChart>> = {
	cloudRun: [
		classes("Requests by response class", `${RUN}.request_count`),
		lines("5xx rate", "percent", [
			{
				name: "5xx rate",
				metric: `${RUN}.request_count`,
				value: failedShare(`${RUN}.request_count`, serverErrors(`${RUN}.request_count`)),
			},
		]),
		lines("Request latency", "milliseconds", percentiles(`${RUN}.request_latencies`)),
		lines("Instances", "count", [
			mean("Active", `${RUN}.container.instance_count`, "active"),
			mean("Idle", `${RUN}.container.instance_count`, "idle"),
		]),
		lines("CPU utilization", "percent", percentiles(`${RUN}.container.cpu.utilizations`), OF_LIMIT),
		lines("Memory utilization", "percent", percentiles(`${RUN}.container.memory.utilizations`), OF_LIMIT),
		lines(
			"Peak concurrent requests per instance",
			"count",
			percentiles(`${RUN}.container.max_request_concurrencies`),
		),
		// Billable seconds per second: how many instances were billed at once.
		lines("Billable instances", "count", [rate("Billed", `${RUN}.container.billable_instance_time`)]),
	],
	cloudFunctions: [
		classes("Executions by status", `${FUNCTION}.execution_count`),
		lines("Error rate", "percent", [
			{
				name: "Error rate",
				metric: `${FUNCTION}.execution_count`,
				value: failedShare(
					`${FUNCTION}.execution_count`,
					unhealthy(`${FUNCTION}.execution_count`, "ok"),
				),
			},
		]),
		lines("Execution time", "milliseconds", percentiles(`${FUNCTION}.execution_times`)),
		lines("Instances", "count", [
			mean("Active", `${FUNCTION}.instance_count`, "active"),
			mean("Idle", `${FUNCTION}.instance_count`, "idle"),
		]),
		lines("Memory per execution", "bytes", percentiles(`${FUNCTION}.user_memory_bytes`)),
		lines("Network egress", "bytes_per_second", [rate("Sent", `${FUNCTION}.network_egress`)]),
	],
	gke: [
		// A point is the CPU seconds used in one minute.
		lines("CPU", "cores", [mean("Usage", `${CONTAINER}.cpu.core_usage_time`, undefined, 1 / 60)]),
		lines("CPU of limit", "percent", [mean("Usage", `${CONTAINER}.cpu.limit_utilization`)], {
			...OF_LIMIT,
			note: "Containers with a CPU limit only.",
		}),
		lines("Memory", "bytes", [
			mean("Non-evictable", `${CONTAINER}.memory.used_bytes`, "non-evictable"),
			mean("Evictable", `${CONTAINER}.memory.used_bytes`, "evictable"),
		]),
		// Non-evictable memory is what counts against the limit.
		lines(
			"Memory of limit",
			"percent",
			[mean("Usage", `${CONTAINER}.memory.limit_utilization`, "non-evictable")],
			{ ...OF_LIMIT, note: "Containers with a memory limit only." },
		),
		lines("Restarts", "count", [count("Restarts", `${CONTAINER}.restart_count`)]),
	],
	computeEngine: [
		lines("CPU utilization", "percent", [mean("Usage", `${INSTANCE}.cpu.utilization`)], OF_LIMIT),
		lines("Memory used", "bytes", [mean("Used", `${INSTANCE}.memory.balloon.ram_used`)], {
			note: "E2 machine types only.",
		}),
		lines("Network", "bytes_per_second", [
			rate("Received", `${INSTANCE}.network.received_bytes_count`),
			rate("Sent", `${INSTANCE}.network.sent_bytes_count`),
		]),
		lines("Disk", "bytes_per_second", [
			rate("Read", `${INSTANCE}.disk.read_bytes_count`),
			rate("Written", `${INSTANCE}.disk.write_bytes_count`),
		]),
	],
	cloudSql: [
		lines("CPU utilization", "percent", [mean("Usage", `${DATABASE}.cpu.utilization`)], OF_LIMIT),
		lines("Memory utilization", "percent", [mean("Usage", `${DATABASE}.memory.utilization`)], OF_LIMIT),
		lines("Disk utilization", "percent", [mean("Usage", `${DATABASE}.disk.utilization`)], OF_LIMIT),
		lines("Connections", "count", [
			// MySQL and SQL Server report the first, PostgreSQL the second.
			{
				name: "Connections",
				metric: `${DATABASE}.network.connections`,
				value: (read) =>
					read.mean(`${DATABASE}.network.connections`) ??
					read.mean(`${DATABASE}.postgresql.num_backends`),
			},
		]),
		lines("Disk operations", "rate", [
			rate("Read", `${DATABASE}.disk.read_ops_count`),
			rate("Write", `${DATABASE}.disk.write_ops_count`),
		]),
		lines(
			"Replica lag",
			"milliseconds",
			[mean("Lag", `${DATABASE}.replication.replica_lag`, undefined, 1000)],
			{ note: "Read replicas only." },
		),
	],
	pubsub: [
		lines("Backlog", "count", [mean("Unacked messages", `${SUBSCRIPTION}.num_undelivered_messages`)]),
		lines("Oldest unacked message", "milliseconds", [
			mean("Age", `${SUBSCRIPTION}.oldest_unacked_message_age`, undefined, 1000),
		]),
		lines("Messages", "rate", [
			rate("Delivered", `${SUBSCRIPTION}.sent_message_count`),
			rate("Acked", `${SUBSCRIPTION}.ack_message_count`),
		]),
		lines("Dead-lettered messages", "count", [
			count("Dead-lettered", `${SUBSCRIPTION}.dead_letter_message_count`),
		]),
		classes("Push requests by response", `${SUBSCRIPTION}.push_request_count`, PUSH_ONLY),
		lines(
			"Push error rate",
			"percent",
			[
				{
					name: "Push errors",
					metric: `${SUBSCRIPTION}.push_request_count`,
					value: failedShare(
						`${SUBSCRIPTION}.push_request_count`,
						unhealthy(`${SUBSCRIPTION}.push_request_count`, "ack"),
					),
				},
			],
			{ note: PUSH_ONLY },
		),
	],
	loadBalancing: [
		classes("Requests by response class", `${HTTPS}.request_count`),
		lines("5xx rate", "percent", [
			{
				name: "5xx rate",
				metric: `${HTTPS}.request_count`,
				value: failedShare(`${HTTPS}.request_count`, serverErrors(`${HTTPS}.request_count`)),
			},
		]),
		lines("Total latency", "milliseconds", percentiles(`${HTTPS}.total_latencies`)),
		lines("Backend latency", "milliseconds", percentiles(`${HTTPS}.backend_latencies`)),
		classes("Backend requests by response class", `${HTTPS}.backend_request_count`),
		lines("Traffic", "bytes_per_second", [
			rate("Requests", `${HTTPS}.request_bytes_count`),
			rate("Responses", `${HTTPS}.response_bytes_count`),
		]),
	],
} satisfies Record<GcpInfraServiceId, ReadonlyArray<GcpChart>>

/** The nodes of a GKE container's cluster, averaged over the nodes: read from the `gkeNodes` source. */
export const GCP_GKE_NODE_CHARTS: ReadonlyArray<GcpChart> = [
	lines(
		"Node CPU of allocatable",
		"percent",
		[mean("Usage", `${NODE}.cpu.allocatable_utilization`)],
		OF_LIMIT,
	),
	lines(
		"Node memory of allocatable",
		"percent",
		[
			mean("Non-evictable", `${NODE}.memory.allocatable_utilization`, "non-evictable"),
			mean("Evictable", `${NODE}.memory.allocatable_utilization`, "evictable"),
		],
		OF_LIMIT,
	),
]

/** The metric a chart opens in the metrics explorer, and the table it is stored in. */
export function gcpChartMetric(chart: GcpChart): { readonly name: string; readonly type: "sum" | "gauge" } {
	const name = chart.kind === "classes" ? chart.metric : chart.series[0].metric
	const kind = GCP_METRIC_GROUPS.flatMap((group) => group.metrics).find(
		(metric) => metric.name === name,
	)?.kind
	return { name, type: kind === "sum" ? "sum" : "gauge" }
}

/** The points of each bucket, oldest first. */
export function gcpBuckets(
	points: ReadonlyArray<GcpBucketPoint>,
): ReadonlyArray<{ readonly bucket: string; readonly points: ReadonlyArray<GcpBucketPoint> }> {
	const byBucket = new Map<string, Array<GcpBucketPoint>>()
	for (const point of points) {
		const bucket = byBucket.get(point.bucket)
		if (bucket === undefined) byBucket.set(point.bucket, [point])
		else bucket.push(point)
	}
	return [...byBucket]
		.map(([bucket, bucketPoints]) => ({ bucket, points: bucketPoints }))
		.sort((a, b) => a.bucket.localeCompare(b.bucket))
}

/** The whole window, each metric and label value once: what the workload's table row reads. */
export function gcpWindowPoints(points: ReadonlyArray<GcpBucketPoint>): ReadonlyArray<GcpMetricValue> {
	const folded = new Map<string, GcpMetricValue>()
	for (const { metric, label, total, samples } of points) {
		const id = `${metric}\u0000${label}`
		const sum = folded.get(id)
		folded.set(id, {
			metric,
			label,
			total: (sum?.total ?? 0) + total,
			samples: (sum?.samples ?? 0) + samples,
		})
	}
	return [...folded.values()]
}

export interface GcpChartRow {
	readonly bucket: string
	readonly attributeValue: string
	readonly value: number
}

/** A line chart's rows: one per bucket and series that has a value there. */
export function gcpLineRows(
	series: ReadonlyArray<GcpSeries>,
	points: ReadonlyArray<GcpBucketPoint>,
	bucketSeconds: number,
): ReadonlyArray<GcpChartRow> {
	return gcpBuckets(points).flatMap(({ bucket, points: bucketPoints }) => {
		const read = gcpMetricReader(bucketPoints)
		return series.flatMap((entry) => {
			const value = entry.value(read, bucketSeconds)
			return value === undefined ? [] : [{ bucket, attributeValue: entry.name, value }]
		})
	})
}

/** The load balancer writes a response class as "500", everything else as "5xx". */
const className = (label: string) =>
	label === "" || label === "0" ? "unknown" : label.replace(/^(\d)00$/, "$1xx")

/**
 * A stacked chart's rows: the counter by label value. Every class the window saw has a row in
 * every bucket the workload reported in, zero where it counted nothing, so a quiet stretch reads
 * as quiet instead of being drawn over.
 */
export function gcpClassRows(
	metric: string,
	points: ReadonlyArray<GcpBucketPoint>,
): ReadonlyArray<GcpChartRow> {
	const counted = points.filter((point) => point.metric === metric)
	const names = [...new Set(counted.map((point) => className(point.label)))]
	return gcpBuckets(points).flatMap(({ bucket, points: bucketPoints }) =>
		names.map((name) => ({
			bucket,
			attributeValue: name,
			value: bucketPoints
				.filter((point) => point.metric === metric && className(point.label) === name)
				.reduce((sum, point) => sum + point.total, 0),
		})),
	)
}

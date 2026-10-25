// A Google Cloud workload's detail page: its signal strips on one time axis, the figures beside
// them and in the rail, and when the trace-gap callout shows. Pure.

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { ServiceOverview } from "@maple/query-engine"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { utilizationLevel, type UtilizationLevel } from "@maple/ui/lib/utilization"

import { formatValueWithUnit, type ChartUnit } from "../chart-units"
import {
	GCP_INFRA_CHARTS,
	gcpBuckets,
	gcpClassRows,
	gcpLineRows,
	gcpSeries,
	gcpWindowPoints,
	type GcpBucketPoint,
	type GcpChartWindow,
	type GcpSeries,
} from "./charts"
import { GCP_IDLE_IN_TRANSACTION, GCP_LIMIT_FRACTION } from "./list-model"
import { gcpMetricReader, serverErrors, unhealthy, type GcpMetricReader } from "./tabs"

const { mean, rate } = gcpSeries

const RUN = "gcp.cloud_run"
const RUN_REQUESTS = `${RUN}.requests`
const RUN_INSTANCES = `${RUN}.container.instance.count`
const RUN_LATENCY = `${RUN}.request.duration`
const FUNCTION = "gcp.cloud_functions"
const EXECUTIONS = `${FUNCTION}.executions`
const FUNCTION_INSTANCES = `${FUNCTION}.instance.count`
const EXECUTION_TIMES = `${FUNCTION}.execution.duration`
const DATABASE = "gcp.cloud_sql"
const SUBSCRIPTION = "gcp.pubsub.subscription"
const PUSH_REQUESTS = `${SUBSCRIPTION}.push_requests`

/** A duration stored in seconds, drawn in milliseconds. */
const MS = 1000

type StripRow = { readonly bucket: string; readonly attributeValue: string; readonly value: number }

/** The figure beside a strip: a window total, a percentile, or the latest reading. */
export interface GcpStripSummary {
	readonly value: string
	readonly caption?: string
	/** Failures counted: drawn in the error colour. */
	readonly alert?: boolean
}

export interface GcpStrip {
	readonly id: string
	readonly label: string
	readonly source: string
	readonly unit: ChartUnit
	readonly rows: ReadonlyArray<StripRow>
	/** Draws the 80% rule: for a share of a limit or of capacity. */
	readonly threshold?: boolean
	readonly colors?: Readonly<Record<string, string>>
	readonly summary: GcpStripSummary
}

const FAILED_COLORS = { failed: "var(--severity-error)" }

const valuesOf = (rows: ReadonlyArray<StripRow>, name: string) =>
	rows.flatMap((row) => (row.attributeValue === name ? [row.value] : []))

const peakOf = (rows: ReadonlyArray<StripRow>, name: string) => {
	const values = valuesOf(rows, name)
	return values.length === 0 ? undefined : Math.max(...values)
}

const figure = (value: number | undefined, unit: ChartUnit) =>
	value === undefined ? EMPTY_VALUE : formatValueWithUnit(value, unit)

const decimal = (value: number | undefined) =>
	value === undefined ? EMPTY_VALUE : value.toLocaleString(undefined, { maximumFractionDigits: 1 })

/** A gauge's last reading in the window, and its peak. */
const latestAndPeak = (rows: ReadonlyArray<StripRow>, name: string, unit: ChartUnit): GcpStripSummary => ({
	value: figure(valuesOf(rows, name).at(-1), unit),
	caption: `latest · peak ${figure(peakOf(rows, name), unit)}`,
})

/** A counter of failures per bucket, its window total and its share of all events. */
function failedStrip(
	id: string,
	label: string,
	metric: string,
	failed: (read: GcpMetricReader) => number,
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
): GcpStrip {
	const read = gcpMetricReader(gcpWindowPoints(points))
	const total = read.total(metric)
	const failures = failed(read)
	return {
		id,
		label,
		source: "count per bucket",
		unit: "count",
		rows: gcpLineRows([{ name: "failed", metric, value: failed }], points, window),
		colors: FAILED_COLORS,
		summary: {
			value: formatNumber(failures),
			caption: total > 0 ? `${formatErrorRate(failures / total)} of ${formatNumber(total)}` : undefined,
			alert: failures > 0,
		},
	}
}

/** Active instances and idle ones kept warm, with the window's peak of active. */
function instancesStrip(
	metric: string,
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
): GcpStrip {
	const rows = gcpLineRows([mean("active", metric, "active"), mean("idle", metric, "idle")], points, window)
	return {
		id: "instances",
		label: "Instances",
		source: "active and idle",
		unit: "count",
		rows,
		summary: { value: decimal(peakOf(rows, "active")), caption: "peak active" },
	}
}

/** p95 and p50 per bucket; the figure is the window's p95, as the list's column reads it. */
function latencyStrip(
	label: string,
	metric: string,
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
): GcpStrip {
	const read = gcpMetricReader(gcpWindowPoints(points))
	const p95 = read.mean(metric, "0.95")
	const p50 = read.mean(metric, "0.5")
	return {
		id: "latency",
		label,
		source: "p95 and p50",
		unit: "milliseconds",
		rows: gcpLineRows([mean("p95", metric, "0.95", MS), mean("p50", metric, "0.5", MS)], points, window),
		summary: {
			value: p95 === undefined ? EMPTY_VALUE : formatLatency(p95 * MS),
			caption: p50 === undefined ? "p95" : `p95 · p50 ${formatLatency(p50 * MS)}`,
		},
	}
}

/** A counter per second by label value, with its window total and its healthy share. */
function classesStrip(
	label: string,
	metric: string,
	healthy: string,
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
): GcpStrip {
	const read = gcpMetricReader(gcpWindowPoints(points))
	const total = read.total(metric)
	return {
		id: "classes",
		label,
		source: "per second, by status",
		unit: "rate",
		rows: gcpClassRows(metric, points, window),
		summary: {
			value: formatNumber(total),
			caption:
				total > 0 ? `${formatPercent(read.total(metric, healthy) / total)} ${healthy}` : undefined,
		},
	}
}

/** A gauge of one or more metrics drawn as one line, with its latest reading. */
function gaugeStrip(
	id: string,
	label: string,
	source: string,
	unit: ChartUnit,
	series: ReadonlyArray<GcpSeries>,
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
): GcpStrip {
	const rows = gcpLineRows(series, points, window)
	return {
		id,
		label,
		source,
		unit,
		rows,
		threshold: unit === "percent",
		summary: latestAndPeak(rows, series[0].name, unit),
	}
}

const IDLE_IN_TRANSACTION = "idle in transaction"
const CONNECTION_COLORS = { [IDLE_IN_TRANSACTION]: "var(--severity-warn)" }

/**
 * A Cloud SQL instance from the database's side: Query Insights latency, connections by state
 * against `max_connections`, the share of query time spent waiting on locks, CPU and memory.
 */
function cloudSqlStrips(
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
	maxConnections: number | null,
): ReadonlyArray<GcpStrip> {
	const read = gcpMetricReader(gcpWindowPoints(points))
	// PostgreSQL splits its connections by state; MySQL reports the open ones only.
	const byState = points.some((point) => point.metric === `${DATABASE}.postgresql.connection.count`)
	const connectionRows = gcpLineRows(
		byState
			? [
					mean("active", `${DATABASE}.postgresql.connection.count`, "active"),
					mean(
						IDLE_IN_TRANSACTION,
						`${DATABASE}.postgresql.connection.count`,
						GCP_IDLE_IN_TRANSACTION,
					),
				]
			: [mean("open", `${DATABASE}.connection.count`)],
		points,
		window,
	)
	const peakOpen = Math.max(
		0,
		...gcpLineRows([mean("open", `${DATABASE}.connection.count`)], points, window).map(
			(row) => row.value,
		),
	)
	const execution = `${DATABASE}.query.execution.time`
	const lockShare: GcpSeries = {
		name: "lock wait",
		metric: `${DATABASE}.query.lock.time`,
		value: (bucket) => {
			const total = bucket.total(execution)
			return total > 0 ? bucket.total(`${DATABASE}.query.lock.time`) / total : undefined
		},
	}
	const lockRows = gcpLineRows([lockShare], points, window)
	const executed = read.total(execution)
	const strips: ReadonlyArray<GcpStrip> = [
		{
			...latencyStrip("Query latency", `${DATABASE}.query.duration`, points, window),
			source: "database side, p95 and p50",
		},
		{
			id: "connections",
			label: "Connections",
			source: byState ? "active and idle in transaction" : "open",
			unit: "count",
			rows: connectionRows,
			colors: CONNECTION_COLORS,
			summary: {
				value: decimal(peakOpen),
				caption: maxConnections === null ? "peak open" : `peak of ${maxConnections} max`,
				alert: maxConnections !== null && peakOpen >= GCP_LIMIT_FRACTION * maxConnections,
			},
		},
		{
			id: "lock-wait",
			label: "Lock wait",
			source: "share of query time",
			unit: "percent",
			rows: lockRows,
			summary: {
				value: figure(peakOf(lockRows, "lock wait"), "percent"),
				caption:
					executed > 0
						? `peak · I/O wait ${formatPercent(read.total(`${DATABASE}.query.io.time`) / executed)}`
						: "peak",
			},
		},
		gaugeStrip(
			"cpu",
			"CPU",
			"share of the reserved cores",
			"percent",
			[mean("CPU", `${DATABASE}.cpu.utilization`)],
			points,
			window,
		),
		gaugeStrip(
			"memory",
			"Memory",
			"share of the instance's memory",
			"percent",
			[mean("Memory", `${DATABASE}.memory.utilization`)],
			points,
			window,
		),
		gaugeStrip(
			"replica-lag",
			"Replica lag",
			"behind the primary",
			"milliseconds",
			[mean("Lag", `${DATABASE}.replication.lag`, undefined, MS)],
			points,
			window,
		),
	]
	// Query Insights is PostgreSQL's, when it is on; replica lag a read replica's.
	return strips.filter((strip) => strip.id === "connections" || strip.id === "cpu" || strip.rows.length > 0)
}

/**
 * The strips of a workload's page, top to bottom. Cloud Run, Cloud Functions, Cloud SQL and
 * Pub/Sub get the signals that explain each other; the rest the first four charts of their tab.
 * A strip that only some workloads report (query insights, replica lag, push delivery) shows when
 * this one did.
 */
export function gcpWorkloadStrips(
	service: GcpInfraServiceId,
	points: ReadonlyArray<GcpBucketPoint>,
	window: GcpChartWindow,
	/** A Cloud SQL instance's `max_connections`, from the inventory. */
	maxConnections: number | null = null,
): ReadonlyArray<GcpStrip> {
	switch (service) {
		case "cloudRun":
			return [
				classesStrip("Requests", RUN_REQUESTS, "2xx", points, window),
				failedStrip("5xx", "5xx", RUN_REQUESTS, serverErrors(RUN_REQUESTS), points, window),
				instancesStrip(RUN_INSTANCES, points, window),
				latencyStrip("Latency", RUN_LATENCY, points, window),
			]
		case "cloudFunctions":
			return [
				classesStrip("Executions", EXECUTIONS, "ok", points, window),
				failedStrip("failed", "Failed", EXECUTIONS, unhealthy(EXECUTIONS, "ok"), points, window),
				instancesStrip(FUNCTION_INSTANCES, points, window),
				latencyStrip("Execution time", EXECUTION_TIMES, points, window),
			]
		case "cloudSql":
			return cloudSqlStrips(points, window, maxConnections)
		case "pubsub": {
			const read = gcpMetricReader(gcpWindowPoints(points))
			const strips = [
				gaugeStrip(
					"backlog",
					"Backlog",
					"unacked messages",
					"count",
					[mean("Unacked", `${SUBSCRIPTION}.undelivered_messages`)],
					points,
					window,
				),
				gaugeStrip(
					"oldest-unacked",
					"Oldest unacked",
					"message age",
					"milliseconds",
					[mean("Age", `${SUBSCRIPTION}.oldest_unacked_message.age`, undefined, MS)],
					points,
					window,
				),
				{
					id: "delivered",
					label: "Delivered vs acked",
					source: "per second",
					unit: "rate",
					rows: gcpLineRows(
						[
							rate("Delivered", `${SUBSCRIPTION}.sent_messages`),
							rate("Acked", `${SUBSCRIPTION}.acked_messages`),
						],
						points,
						window,
					),
					summary: {
						value: formatNumber(read.total(`${SUBSCRIPTION}.sent_messages`)),
						caption: `${formatNumber(read.total(`${SUBSCRIPTION}.acked_messages`))} acked`,
					},
				} satisfies GcpStrip,
			]
			// Push subscriptions only.
			return read.total(PUSH_REQUESTS) > 0
				? [
						...strips,
						failedStrip(
							"push-failed",
							"Push failed",
							PUSH_REQUESTS,
							unhealthy(PUSH_REQUESTS, "ack"),
							points,
							window,
						),
					]
				: strips
		}
		case "gke":
		case "computeEngine":
		case "loadBalancing":
			return GCP_INFRA_CHARTS[service].slice(0, 4).map((chart): GcpStrip => {
				if (chart.kind === "classes") {
					const read = gcpMetricReader(gcpWindowPoints(points))
					return {
						id: chart.title,
						label: chart.title,
						source: "per second",
						unit: "rate",
						rows: gcpClassRows(chart.metric, points, window),
						summary: { value: formatNumber(read.total(chart.metric)), caption: "in window" },
					}
				}
				const rows = gcpLineRows(chart.series, points, window)
				return {
					id: chart.title,
					label: chart.title,
					source: chart.series.map((series) => series.name).join(" · "),
					unit: chart.unit,
					rows,
					threshold: chart.threshold,
					summary: {
						value: figure(peakOf(rows, chart.series[0].name), chart.unit),
						caption: "peak",
					},
				}
			})
	}
}

/** Every bucket the strips share, oldest first: see `gcpBuckets`. */
export const gcpStripDomain = (
	points: ReadonlyArray<GcpBucketPoint>,
	bucketSeconds: number,
): ReadonlyArray<string> => gcpBuckets(points, bucketSeconds).map(({ bucket }) => bucket)

/**
 * The errors the traced service of this name recorded on its entry spans in the window,
 * sampling-corrected, over every environment: null when it sent no spans.
 */
export function gcpTracedErrors(
	rows: ReadonlyArray<Pick<ServiceOverview, "serviceName" | "errorRate" | "throughput">>,
	serviceName: string,
	windowSeconds: number,
): number | null {
	const matched = rows.filter((row) => row.serviceName === serviceName)
	if (matched.length === 0) return null
	return Math.round(matched.reduce((sum, row) => sum + row.errorRate * row.throughput * windowSeconds, 0))
}

/** Server errors Google counted that the workload's own spans never recorded. */
export interface GcpTraceGap {
	readonly platformErrors: number
	readonly tracedErrors: number
	/** The buckets that hold the errors: from the first one's start to the last one's end. */
	readonly fromMs: number
	readonly untilMs: number
	/** The window's peak of active instances, when every one of those buckets ran at it. */
	readonly peakInstances: number | undefined
}

const GAP_SOURCES = {
	cloudRun: { failed: serverErrors(RUN_REQUESTS), instances: RUN_INSTANCES },
	cloudFunctions: { failed: unhealthy(EXECUTIONS, "ok"), instances: FUNCTION_INSTANCES },
}

/** Fewer untraced errors than this is sampling or a slow exporter, not a finding. */
const GAP_MIN_UNTRACED = 100
/** A bucket holds the errors when it counted at least this share of the worst bucket's. */
const ERROR_BUCKET_SHARE = 0.1
/** Within this of the peak still reads as "at the peak": a mean over a bucket is not a whole count. */
const AT_PEAK = 0.95

/**
 * Worth a callout only when Google counted clearly more errors than the traces did: at least
 * twice as many, and 100 more. Those requests were answered before the workload's code ran.
 */
export function gcpTraceGap(
	service: GcpInfraServiceId,
	points: ReadonlyArray<GcpBucketPoint>,
	bucketSeconds: number,
	tracedErrors: number | null,
): GcpTraceGap | null {
	if (tracedErrors === null || (service !== "cloudRun" && service !== "cloudFunctions")) return null
	const source = GAP_SOURCES[service]
	const buckets = gcpBuckets(points, bucketSeconds).map(({ bucket, points: bucketPoints }) => {
		const read = gcpMetricReader(bucketPoints)
		return {
			at: toEpochMs(bucket),
			failed: source.failed(read),
			instances: read.mean(source.instances, "active"),
		}
	})
	const platformErrors = buckets.reduce((sum, bucket) => sum + bucket.failed, 0)
	if (platformErrors < 2 * tracedErrors || platformErrors - tracedErrors < GAP_MIN_UNTRACED) return null
	const worst = Math.max(...buckets.map((bucket) => bucket.failed))
	const erroring = buckets.filter((bucket) => bucket.failed >= worst * ERROR_BUCKET_SHARE)
	const peak = Math.max(0, ...buckets.map((bucket) => bucket.instances ?? 0))
	const atPeak =
		peak > 0 &&
		erroring.every((bucket) => bucket.instances !== undefined && bucket.instances >= peak * AT_PEAK)
	return {
		platformErrors,
		tracedErrors,
		fromMs: erroring[0].at,
		untilMs: erroring[erroring.length - 1].at + bucketSeconds * 1000,
		peakInstances: atPeak ? Math.round(peak) : undefined,
	}
}

/** A line of the rail's facts. */
export interface GcpRailFact {
	readonly label: string
	readonly value: string
	/** How a share reads: good, nearing a limit, at it. Absent for a value that is no share. */
	readonly tone?: UtilizationLevel
}

/** A share of a limit: fine below 60%, a warning from 60%, critical from 90%. */
export const gcpShareTone = (fraction: number | undefined): UtilizationLevel | undefined =>
	fraction === undefined ? undefined : utilizationLevel(fraction)

/** The latest reading of a gauge in the window, by bucket. */
function latest(points: ReadonlyArray<GcpBucketPoint>, bucketSeconds: number, metric: string) {
	for (const { points: bucketPoints } of gcpBuckets(points, bucketSeconds).toReversed()) {
		const value = gcpMetricReader(bucketPoints).mean(metric)
		if (value !== undefined) return value
	}
	return undefined
}

const facts = (
	entries: ReadonlyArray<readonly [label: string, value: string | undefined, tone?: UtilizationLevel]>,
) =>
	entries.flatMap(([label, value, tone]): ReadonlyArray<GcpRailFact> =>
		value === undefined ? [] : [{ label, value, tone }],
	)

const percentOf = (value: number | undefined) => (value === undefined ? undefined : formatPercent(value))
/** A share as its percentage and its tone, for `facts`. */
const share = (label: string, value: number | undefined) =>
	[label, percentOf(value), gcpShareTone(value)] as const

/** Bytes as whole GB, as the Cloud SQL console sizes a disk. */
const gibibytes = (bytes: number) => Math.round(bytes / 1024 ** 3).toLocaleString()

/**
 * What the rail says about a workload beyond its identity: Cloud Run's container over the window,
 * a Cloud SQL instance's disk now. A reading the workload never reported is left out.
 */
export function gcpRailFacts(
	service: GcpInfraServiceId,
	points: ReadonlyArray<GcpBucketPoint>,
	bucketSeconds: number,
): ReadonlyArray<GcpRailFact> {
	const read = gcpMetricReader(gcpWindowPoints(points))
	switch (service) {
		case "cloudRun": {
			const billed = read.total(`${RUN}.container.billable_time`)
			const concurrency = read.mean(`${RUN}.container.request.max_concurrency`, "0.95")
			return facts([
				share("cpu p95", read.mean(`${RUN}.container.cpu.utilization`, "0.95")),
				share("memory p95", read.mean(`${RUN}.container.memory.utilization`, "0.95")),
				[
					"concurrency",
					concurrency === undefined ? undefined : `${decimal(concurrency)} per instance, p95`,
				],
				// Billable seconds: the instance time the window costs.
				["billable", billed > 0 ? `${formatLatency(billed * MS)} in window` : undefined],
			])
		}
		case "cloudFunctions": {
			const memory = read.mean(`${FUNCTION}.memory.usage`, "0.95")
			return facts([["memory p95", memory === undefined ? undefined : formatBytes(memory)]])
		}
		case "cloudSql": {
			const lag = latest(points, bucketSeconds, `${DATABASE}.replication.lag`)
			const used = latest(points, bucketSeconds, `${DATABASE}.disk.usage`)
			const quota = latest(points, bucketSeconds, `${DATABASE}.disk.limit`)
			const disk =
				used !== undefined && quota !== undefined && quota > 0
					? used / quota
					: latest(points, bucketSeconds, `${DATABASE}.disk.utilization`)
			return facts([
				[
					"disk",
					used !== undefined && quota !== undefined
						? `${gibibytes(used)} of ${gibibytes(quota)} GB`
						: percentOf(disk),
					gcpShareTone(disk),
				],
				["replica lag", lag === undefined ? undefined : formatLatency(lag * MS)],
			])
		}
		case "gke":
		case "computeEngine":
		case "pubsub":
		case "loadBalancing":
			return []
	}
}

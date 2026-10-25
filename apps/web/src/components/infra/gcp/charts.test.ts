import { describe, expect, it } from "vitest"

import { GCP_INFRA_SERVICE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import {
	GCP_GKE_NODE_CHARTS,
	GCP_INFRA_CHARTS,
	gcpBuckets,
	gcpChartMetric,
	gcpClassRows,
	gcpLineRows,
	gcpWindowPoints,
	type GcpBucketPoint,
	type GcpChart,
} from "./charts"
import { gcpWorkload, type GcpMetricReader } from "./tabs"

const T1 = "2026-10-08T12:00:00.000Z"
const T2 = "2026-10-08T12:05:00.000Z"
/** A window that holds both buckets whole. */
const WINDOW = { startTime: "2026-10-08 12:00:00", endTime: "2026-10-08 12:10:00", bucketSeconds: 300 }

const point = (
	bucket: string,
	metric: string,
	label: string,
	total: number,
	samples = 1,
): GcpBucketPoint => ({
	bucket,
	metric,
	label,
	total,
	samples,
})

/** The metrics a chart reads, by running its series against a reader that records them. */
const metricsOf = (chart: GcpChart): ReadonlyArray<string> => {
	if (chart.kind === "classes") return [chart.metric]
	const read: Array<string> = []
	const recorder: GcpMetricReader = {
		total: (metric) => {
			read.push(metric)
			return 0
		},
		mean: (metric) => {
			read.push(metric)
			return undefined
		},
	}
	for (const series of chart.series) {
		series.value(recorder, 300)
		read.push(series.metric)
	}
	return read
}

const lineChart = (service: (typeof GCP_INFRA_SERVICE_IDS)[number], title: string) => {
	const chart = GCP_INFRA_CHARTS[service].find((candidate) => candidate.title === title)
	if (chart?.kind !== "lines") throw new Error(`no line chart ${title}`)
	return chart
}

describe("GCP_INFRA_CHARTS", () => {
	it("reads only metrics the page's query returns", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const known = new Set(gcpInfraMetrics(service).map((metric) => metric.name))
			const read = GCP_INFRA_CHARTS[service].flatMap(metricsOf)
			expect(read.length, service).toBeGreaterThan(0)
			expect(
				read.filter((metric) => !known.has(metric)),
				service,
			).toEqual([])
		}
		const nodes = new Set(gcpInfraMetrics("gkeNodes").map((metric) => metric.name))
		expect(GCP_GKE_NODE_CHARTS.flatMap(metricsOf).filter((metric) => !nodes.has(metric))).toEqual([])
	})

	it("titles every chart uniquely on its page", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const titles = GCP_INFRA_CHARTS[service].map((chart) => chart.title)
			expect(new Set(titles).size, service).toBe(titles.length)
		}
	})

	it("opens a counter as a sum and a gauge or percentile as a gauge", () => {
		// The explorer keeps apart what the chart draws apart: the classes, the percentiles.
		expect(gcpChartMetric(GCP_INFRA_CHARTS.cloudRun[0], [])).toEqual({
			name: "gcp.cloud_run.requests",
			type: "sum",
			groupBy: "attr.gcp.metric.labels.response_code_class",
		})
		expect(gcpChartMetric(lineChart("cloudRun", "Request latency"), [])).toEqual({
			name: "gcp.cloud_run.request.duration",
			type: "gauge",
			groupBy: "attr.quantile",
		})
		expect(gcpChartMetric(lineChart("computeEngine", "Network bytes per second"), [])).toEqual({
			name: "gcp.gce.network.io",
			type: "sum",
			groupBy: "attr.network.io.direction",
		})
		expect(gcpChartMetric(lineChart("cloudSql", "CPU utilization"), []).groupBy).toBeUndefined()
	})
})

describe("gcpLineRows", () => {
	it("draws a percentile per series in milliseconds and leaves a gap where it did not report", () => {
		const rows = gcpLineRows(
			lineChart("cloudRun", "Request latency").series,
			[
				point(T1, "gcp.cloud_run.request.duration", "0.5", 0.5, 4),
				point(T1, "gcp.cloud_run.request.duration", "0.99", 1.5, 2),
				point(T2, "gcp.cloud_run.request.duration", "0.5", 0.25, 2),
			],
			WINDOW,
		)
		expect(rows).toEqual([
			{ bucket: T1, attributeValue: "p50", value: 125 },
			{ bucket: T1, attributeValue: "p99", value: 750 },
			{ bucket: T2, attributeValue: "p50", value: 125 },
		])
	})

	it("reads a counter per second, zero in a bucket where the workload reported but counted nothing", () => {
		const rows = gcpLineRows(
			lineChart("computeEngine", "Network bytes per second").series,
			[
				point(T1, "gcp.gce.network.io", "receive", 600_000, 5),
				point(T2, "gcp.gce.cpu.utilization", "", 0.5, 5),
			],
			WINDOW,
		)
		expect(rows).toEqual([
			{ bucket: T1, attributeValue: "Received", value: 2000 },
			{ bucket: T1, attributeValue: "Sent", value: 0 },
			{ bucket: T2, attributeValue: "Received", value: 0 },
			{ bucket: T2, attributeValue: "Sent", value: 0 },
		])
	})

	it("divides a counter by the part of an edge bucket the window covers", () => {
		const received = [point(T1, "gcp.gce.network.io", "receive", 120_000, 2)]
		const rows = gcpLineRows(lineChart("computeEngine", "Network bytes per second").series, received, {
			...WINDOW,
			// The window opens three minutes into the bucket.
			startTime: "2026-10-08 12:03:00",
		})
		expect(rows[0]).toEqual({ bucket: T1, attributeValue: "Received", value: 1000 })
		// A window that ends seconds into its last bucket still divides by one point's minute.
		expect(
			gcpLineRows(lineChart("computeEngine", "Network bytes per second").series, received, {
				...WINDOW,
				endTime: "2026-10-08 12:00:10",
			})[0]?.value,
		).toBe(2000)
	})

	it("turns CPU seconds per minute into cores and a lag in seconds into milliseconds", () => {
		expect(
			gcpLineRows(
				lineChart("gke", "CPU cores").series,
				[point(T1, "gcp.gke.container.cpu.time", "", 150, 5)],
				WINDOW,
			),
		).toEqual([{ bucket: T1, attributeValue: "Usage", value: 0.5 }])
		expect(
			gcpLineRows(
				lineChart("cloudSql", "Replica lag").series,
				[point(T1, "gcp.cloud_sql.replication.lag", "", 2.5, 5)],
				WINDOW,
			),
		).toEqual([{ bucket: T1, attributeValue: "Lag", value: 500 }])
	})

	it("draws an error rate only where there was traffic", () => {
		const rows = gcpLineRows(
			lineChart("loadBalancing", "5xx rate").series,
			[
				point(T1, "gcp.load_balancing.requests", "200", 90),
				point(T1, "gcp.load_balancing.requests", "500", 10),
				point(T2, "gcp.load_balancing.request.duration", "0.5", 10),
			],
			WINDOW,
		)
		expect(rows).toEqual([{ bucket: T1, attributeValue: "5xx rate", value: 0.1 }])
	})
})

describe("gcpClassRows", () => {
	it("draws a counter per second by class, zero where a class counted nothing", () => {
		const rows = gcpClassRows(
			"gcp.load_balancing.requests",
			[
				point(T1, "gcp.load_balancing.requests", "200", 900),
				point(T1, "gcp.load_balancing.requests", "500", 30),
				point(T1, "gcp.load_balancing.requests", "0", 3),
				point(T2, "gcp.load_balancing.request.duration", "0.5", 10),
			],
			WINDOW,
		)
		expect(rows).toEqual([
			{ bucket: T1, attributeValue: "2xx", value: 3 },
			{ bucket: T1, attributeValue: "5xx", value: 0.1 },
			{ bucket: T1, attributeValue: "unknown", value: 0.01 },
			{ bucket: T2, attributeValue: "2xx", value: 0 },
			{ bucket: T2, attributeValue: "5xx", value: 0 },
			{ bucket: T2, attributeValue: "unknown", value: 0 },
		])
	})

	it("is empty for a counter that never counted", () => {
		expect(
			gcpClassRows(
				"gcp.pubsub.subscription.push_requests",
				[point(T1, "gcp.pubsub.subscription.undelivered_messages", "", 4)],
				WINDOW,
			),
		).toEqual([])
	})
})

describe("gcpBuckets", () => {
	const T4 = "2026-10-08T12:15:00.000Z"
	const idle = [
		point(T1, "gcp.cloud_run.requests", "2xx", 300),
		point(T1, "gcp.cloud_run.request.duration", "0.5", 0.5, 4),
		// The service scaled to zero and reported nothing for two buckets.
		point(T4, "gcp.cloud_run.requests", "2xx", 600),
		point(T4, "gcp.cloud_run.request.duration", "0.5", 1, 4),
	]
	const window = { ...WINDOW, endTime: "2026-10-08 12:20:00" }

	it("keeps the silent buckets between the first and the last that reported", () => {
		expect(gcpBuckets(idle, 300).map(({ bucket, points }) => [bucket, points.length])).toEqual([
			[T1, 2],
			[T2, 0],
			["2026-10-08T12:10:00.000Z", 0],
			[T4, 2],
		])
		expect(gcpBuckets([], 300)).toEqual([])
	})

	it("reads a counter as zero through the silence and leaves a gauge out of it", () => {
		const requests = gcpClassRows("gcp.cloud_run.requests", idle, window)
		expect(requests.map((row) => row.value)).toEqual([1, 0, 0, 2])
		const latency = gcpLineRows(lineChart("cloudRun", "Request latency").series, idle, window)
		expect(latency.map((row) => [row.bucket, row.value])).toEqual([
			[T1, 125],
			[T4, 250],
		])
	})
})

describe("gcpWindowPoints", () => {
	const points = [
		point(T2, "gcp.cloud_run.requests", "2xx", 40),
		point(T1, "gcp.cloud_run.requests", "2xx", 50),
		point(T1, "gcp.cloud_run.requests", "5xx", 10),
		point(T1, "gcp.cloud_run.request.duration", "0.95", 0.5, 2),
		point(T2, "gcp.cloud_run.request.duration", "0.95", 0.25, 2),
	]

	it("orders buckets oldest first", () => {
		expect(gcpBuckets(points, 300).map(({ bucket }) => bucket)).toEqual([T1, T2])
	})

	it("folds the buckets into the numbers of the workload's table row", () => {
		const workload = gcpWorkload("cloudRun", ["api"], gcpWindowPoints(points))
		// Requests, 5xx rate, latency p95: a total, a share of the total, a mean over every point.
		expect(workload.values.slice(0, 3)).toEqual([100, 0.1, 0.1875])
		expect(workload.errors).toBe("crit")
	})
})

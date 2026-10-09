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
		expect(gcpChartMetric(GCP_INFRA_CHARTS.cloudRun[0], [])).toEqual({
			name: "gcp.run.request_count",
			type: "sum",
		})
		expect(gcpChartMetric(lineChart("cloudRun", "Request latency"), [])).toEqual({
			name: "gcp.run.request_latencies",
			type: "gauge",
		})
	})

	it("opens the metric that reported when two engines name a reading apart", () => {
		const connections = lineChart("cloudSql", "Connections")
		expect(gcpChartMetric(connections, []).name).toBe("gcp.cloudsql.database.network.connections")
		expect(
			gcpChartMetric(connections, [point(T1, "gcp.cloudsql.database.postgresql.num_backends", "", 12)])
				.name,
		).toBe("gcp.cloudsql.database.postgresql.num_backends")
	})
})

describe("gcpLineRows", () => {
	it("draws a percentile per series and leaves a gap where it did not report", () => {
		const rows = gcpLineRows(
			lineChart("cloudRun", "Request latency").series,
			[
				point(T1, "gcp.run.request_latencies", "0.5", 60, 5),
				point(T1, "gcp.run.request_latencies", "0.99", 900, 5),
				point(T2, "gcp.run.request_latencies", "0.5", 20, 2),
			],
			WINDOW,
		)
		expect(rows).toEqual([
			{ bucket: T1, attributeValue: "p50", value: 12 },
			{ bucket: T1, attributeValue: "p99", value: 180 },
			{ bucket: T2, attributeValue: "p50", value: 10 },
		])
	})

	it("reads a counter per second, zero in a bucket where the workload reported but counted nothing", () => {
		const rows = gcpLineRows(
			lineChart("computeEngine", "Network").series,
			[
				point(T1, "gcp.compute.instance.network.received_bytes_count", "vm-1", 600_000, 5),
				point(T2, "gcp.compute.instance.cpu.utilization", "vm-1", 0.5, 5),
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
		const received = [point(T1, "gcp.compute.instance.network.received_bytes_count", "vm-1", 120_000, 2)]
		const rows = gcpLineRows(lineChart("computeEngine", "Network").series, received, {
			...WINDOW,
			// The window opens three minutes into the bucket.
			startTime: "2026-10-08 12:03:00",
		})
		expect(rows[0]).toEqual({ bucket: T1, attributeValue: "Received", value: 1000 })
		// A window that ends seconds into its last bucket still divides by one point's minute.
		expect(
			gcpLineRows(lineChart("computeEngine", "Network").series, received, {
				...WINDOW,
				endTime: "2026-10-08 12:00:10",
			})[0]?.value,
		).toBe(2000)
	})

	it("draws one connections line whichever engine reports", () => {
		const series = lineChart("cloudSql", "Connections").series
		expect(
			gcpLineRows(
				series,
				[point(T1, "gcp.cloudsql.database.postgresql.num_backends", "", 60, 5)],
				WINDOW,
			),
		).toEqual([{ bucket: T1, attributeValue: "Connections", value: 12 }])
		expect(
			gcpLineRows(series, [point(T1, "gcp.cloudsql.database.network.connections", "", 40, 5)], WINDOW),
		).toEqual([{ bucket: T1, attributeValue: "Connections", value: 8 }])
	})

	it("turns CPU seconds per minute into cores and a lag in seconds into milliseconds", () => {
		expect(
			gcpLineRows(
				lineChart("gke", "CPU").series,
				[point(T1, "gcp.kubernetes.container.cpu.core_usage_time", "", 150, 5)],
				WINDOW,
			),
		).toEqual([{ bucket: T1, attributeValue: "Usage", value: 0.5 }])
		expect(
			gcpLineRows(
				lineChart("cloudSql", "Replica lag").series,
				[point(T1, "gcp.cloudsql.database.replication.replica_lag", "", 2.5, 5)],
				WINDOW,
			),
		).toEqual([{ bucket: T1, attributeValue: "Lag", value: 500 }])
	})

	it("draws an error rate only where there was traffic", () => {
		const rows = gcpLineRows(
			lineChart("loadBalancing", "5xx rate").series,
			[
				point(T1, "gcp.loadbalancing.https.request_count", "200", 90),
				point(T1, "gcp.loadbalancing.https.request_count", "500", 10),
				point(T2, "gcp.loadbalancing.https.total_latencies", "0.5", 10),
			],
			WINDOW,
		)
		expect(rows).toEqual([{ bucket: T1, attributeValue: "5xx rate", value: 0.1 }])
	})
})

describe("gcpClassRows", () => {
	it("stacks a counter by class, zero-filled over the buckets the workload reported in", () => {
		const rows = gcpClassRows("gcp.loadbalancing.https.request_count", [
			point(T1, "gcp.loadbalancing.https.request_count", "200", 90),
			point(T1, "gcp.loadbalancing.https.request_count", "500", 10),
			point(T1, "gcp.loadbalancing.https.request_count", "0", 1),
			point(T2, "gcp.loadbalancing.https.total_latencies", "0.5", 10),
		])
		expect(rows).toEqual([
			{ bucket: T1, attributeValue: "2xx", value: 90 },
			{ bucket: T1, attributeValue: "5xx", value: 10 },
			{ bucket: T1, attributeValue: "unknown", value: 1 },
			{ bucket: T2, attributeValue: "2xx", value: 0 },
			{ bucket: T2, attributeValue: "5xx", value: 0 },
			{ bucket: T2, attributeValue: "unknown", value: 0 },
		])
	})

	it("is empty for a counter that never counted", () => {
		expect(
			gcpClassRows("gcp.pubsub.subscription.push_request_count", [
				point(T1, "gcp.pubsub.subscription.num_undelivered_messages", "", 4),
			]),
		).toEqual([])
	})
})

describe("gcpWindowPoints", () => {
	const points = [
		point(T2, "gcp.run.request_count", "2xx", 40),
		point(T1, "gcp.run.request_count", "2xx", 50),
		point(T1, "gcp.run.request_count", "5xx", 10),
		point(T1, "gcp.run.request_latencies", "0.95", 500, 5),
		point(T2, "gcp.run.request_latencies", "0.95", 100, 5),
	]

	it("orders buckets oldest first", () => {
		expect(gcpBuckets(points).map(({ bucket }) => bucket)).toEqual([T1, T2])
	})

	it("folds the buckets into the numbers of the workload's table row", () => {
		const workload = gcpWorkload("cloudRun", ["api"], gcpWindowPoints(points))
		// Requests, 5xx rate, latency p95: a total, a share of the total, a mean over every point.
		expect(workload.values.slice(0, 3)).toEqual([100, 0.1, 60])
		expect(workload.errors).toBe("crit")
	})
})

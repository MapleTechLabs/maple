import { describe, expect, it } from "vitest"

import type { GcpBucketPoint } from "./charts"
import { gcpRailFacts, gcpTraceGap, gcpTracedErrors, gcpWorkloadStrips } from "./workload-signals"

const BUCKET_SECONDS = 300
const START_MS = Date.parse("2026-10-14T12:00:00.000Z")
const at = (index: number) => new Date(START_MS + index * BUCKET_SECONDS * 1000).toISOString()
/** Six whole buckets. */
const WINDOW = {
	startTime: "2026-10-14 12:00:00",
	endTime: "2026-10-14 12:30:00",
	bucketSeconds: BUCKET_SECONDS,
}

const point = (index: number, metric: string, label: string, total: number, samples = 1): GcpBucketPoint => ({
	bucket: at(index),
	metric,
	label,
	total,
	samples,
})

const REQUESTS = "gcp.cloud_run.requests"
const INSTANCES = "gcp.cloud_run.container.instance.count"

/** 1,000 2xx a bucket; 5xx only in buckets 2 and 3, active instances given per bucket. */
const cloudRun = (
	activeInstances: ReadonlyArray<number>,
	serverErrors = 500,
): ReadonlyArray<GcpBucketPoint> =>
	activeInstances.flatMap((active, index) => [
		point(index, REQUESTS, "2xx", 1000),
		...(index === 2 || index === 3 ? [point(index, REQUESTS, "5xx", serverErrors)] : []),
		point(index, INSTANCES, "active", active),
	])

describe("gcpTraceGap", () => {
	it("spans the buckets that hold the errors and names the peak the instances sat at", () => {
		const gap = gcpTraceGap("cloudRun", cloudRun([4, 8, 20, 20, 9, 5]), BUCKET_SECONDS, 40)
		expect(gap).toEqual({
			platformErrors: 1000,
			tracedErrors: 40,
			fromMs: Date.parse(at(2)),
			untilMs: Date.parse(at(4)),
			peakInstances: 20,
		})
	})

	it("leaves the peak out when the instances were below it while the errors came back", () => {
		const gap = gcpTraceGap("cloudRun", cloudRun([20, 8, 6, 6, 9, 5]), BUCKET_SECONDS, 0)
		expect(gap?.peakInstances).toBeUndefined()
	})

	it("stays quiet when the traces saw more than half of the errors", () => {
		expect(gcpTraceGap("cloudRun", cloudRun([4, 4, 4, 4, 4, 4]), BUCKET_SECONDS, 600)).toBeNull()
	})

	it("stays quiet under 100 untraced errors", () => {
		expect(gcpTraceGap("cloudRun", cloudRun([4, 4, 4, 4, 4, 4], 45), BUCKET_SECONDS, 0)).toBeNull()
	})

	it("needs a traced service to compare with", () => {
		expect(gcpTraceGap("cloudRun", cloudRun([4, 4, 4, 4, 4, 4]), BUCKET_SECONDS, null)).toBeNull()
	})

	it("counts a function's executions that did not end ok", () => {
		const points = [
			point(0, "gcp.cloud_functions.executions", "ok", 900),
			point(0, "gcp.cloud_functions.executions", "timeout", 300),
			point(1, "gcp.cloud_functions.executions", "crash", 100),
		]
		expect(gcpTraceGap("cloudFunctions", points, BUCKET_SECONDS, 10)?.platformErrors).toBe(400)
	})
})

describe("gcpTracedErrors", () => {
	it("adds up the service's errors over its environments", () => {
		const rows = [
			{ serviceName: "checkout-api", errorRate: 0.01, throughput: 10 },
			{ serviceName: "checkout-api", errorRate: 0.5, throughput: 0.1 },
			{ serviceName: "orders-worker", errorRate: 1, throughput: 100 },
		]
		// 0.1/s and 0.05/s of errors over an hour.
		expect(gcpTracedErrors(rows, "checkout-api", 3600)).toBe(540)
	})

	it("is null for a service that sent no spans", () => {
		expect(gcpTracedErrors([], "checkout-api", 3600)).toBeNull()
	})
})

describe("gcpWorkloadStrips", () => {
	it("counts Cloud Run's 5xx per bucket, with the window's total and share", () => {
		const strips = gcpWorkloadStrips("cloudRun", cloudRun([4, 4, 4, 4, 4, 4]), WINDOW)
		const serverErrors = strips.find((strip) => strip.label === "5xx")
		expect(serverErrors?.rows.map((row) => row.value)).toEqual([0, 0, 500, 500, 0, 0])
		expect(serverErrors?.summary).toEqual({ value: "1.0K", caption: "14.3% of 7.0K", alert: true })
	})

	it("draws latency in milliseconds from the seconds Google stores", () => {
		const points = [
			point(0, "gcp.cloud_run.request.duration", "0.95", 1.2),
			point(0, "gcp.cloud_run.request.duration", "0.5", 0.2),
		]
		const latency = gcpWorkloadStrips("cloudRun", points, WINDOW).find((strip) => strip.id === "latency")
		expect(latency?.rows).toEqual([
			{ bucket: at(0), attributeValue: "p95", value: 1200 },
			{ bucket: at(0), attributeValue: "p50", value: 200 },
		])
		expect(latency?.summary.value).toBe("1.20s")
	})

	it("shows query insights and replica lag only for an instance that reports them", () => {
		const primary = [point(0, "gcp.cloud_sql.cpu.utilization", "", 0.4)]
		const insights = [
			...primary,
			point(0, "gcp.cloud_sql.query.duration", "0.95", 0.34),
			point(0, "gcp.cloud_sql.query.execution.time", "", 100),
			point(0, "gcp.cloud_sql.query.lock.time", "", 31),
		]
		const replica = [...primary, point(0, "gcp.cloud_sql.replication.lag", "", 4)]
		const labels = (points: ReadonlyArray<GcpBucketPoint>) =>
			gcpWorkloadStrips("cloudSql", points, WINDOW).map((strip) => strip.label)
		expect(labels(primary)).toEqual(["Connections", "CPU"])
		expect(labels(insights)).toEqual(["Query latency", "Connections", "Lock wait", "CPU"])
		expect(labels(replica)).toEqual(["Connections", "CPU", "Replica lag"])
	})

	it("draws lock wait as a share of query time", () => {
		const points = [
			point(0, "gcp.cloud_sql.query.execution.time", "", 100),
			point(0, "gcp.cloud_sql.query.lock.time", "", 31),
			point(0, "gcp.cloud_sql.query.io.time", "", 4),
		]
		const lock = gcpWorkloadStrips("cloudSql", points, WINDOW).find((strip) => strip.id === "lock-wait")
		expect(lock?.rows).toEqual([{ bucket: at(0), attributeValue: "lock wait", value: 0.31 }])
	})

	it("splits PostgreSQL's connections by state and measures the peak against max_connections", () => {
		const points = [
			point(0, "gcp.cloud_sql.connection.count", "", 60),
			point(1, "gcp.cloud_sql.connection.count", "", 97),
			point(1, "gcp.cloud_sql.postgresql.connection.count", "active", 59),
			point(1, "gcp.cloud_sql.postgresql.connection.count", "idle_in_transaction", 38),
		]
		const connections = gcpWorkloadStrips("cloudSql", points, WINDOW, 100).find(
			(strip) => strip.id === "connections",
		)
		expect(connections?.rows.map((row) => row.attributeValue)).toEqual(["active", "idle in transaction"])
		expect(connections?.summary).toEqual({ value: "97", caption: "peak of 100 max", alert: true })
	})

	it("shows push failures only for a push subscription", () => {
		const pull = [point(0, "gcp.pubsub.subscription.sent_messages", "", 100)]
		const push = [
			...pull,
			point(0, "gcp.pubsub.subscription.push_requests", "ack", 90),
			point(0, "gcp.pubsub.subscription.push_requests", "internal", 10),
		]
		expect(gcpWorkloadStrips("pubsub", pull, WINDOW).map((strip) => strip.label)).not.toContain(
			"Push failed",
		)
		const failed = gcpWorkloadStrips("pubsub", push, WINDOW).find(
			(strip) => strip.label === "Push failed",
		)
		expect(failed?.summary.value).toBe("10")
	})
})

describe("gcpRailFacts", () => {
	it("reads a Cloud SQL instance's disk in its latest bucket, as a share without its quota", () => {
		const sized = [
			point(0, "gcp.cloud_sql.disk.usage", "", 300 * 1024 ** 3),
			point(1, "gcp.cloud_sql.disk.usage", "", 355 * 1024 ** 3),
			point(1, "gcp.cloud_sql.disk.limit", "", 500 * 1024 ** 3),
		]
		expect(gcpRailFacts("cloudSql", sized, BUCKET_SECONDS)).toEqual([
			{ label: "disk", value: "355 of 500 GB", tone: "warn" },
		])
		expect(
			gcpRailFacts("cloudSql", [point(0, "gcp.cloud_sql.disk.utilization", "", 0.71)], BUCKET_SECONDS),
		).toEqual([{ label: "disk", value: "71%", tone: "warn" }])
	})

	it("totals Cloud Run's billable instance time over the window", () => {
		const points = [
			point(0, "gcp.cloud_run.container.billable_time", "", 3600),
			point(1, "gcp.cloud_run.container.billable_time", "", 3600),
		]
		expect(gcpRailFacts("cloudRun", points, BUCKET_SECONDS)).toEqual([
			{ label: "billable", value: "2.0h in window" },
		])
	})
})

import { ServiceName } from "@maple/domain/http"
import { Array as Arr, Order, Schema } from "effect"
import type { ServiceRuntime } from "../page/kit/service-runtimes"
import type { Issue, Usage, Workload } from "../page/services/detail/model"
import type { ServiceDeploys } from "../page/services/detail/model-deploys"
import type { DependencyBundle, Operation } from "../page/services/detail/model-tabs"
import { type Commit, type DetailPoint, type Release } from "../page/kit/service-metrics/points"

// `/lab/service-runtimes`: one hour of `fleet-api`, a Go API on Google Cloud Run behind
// `fleet-web`, called by `fleet-worker`, reading Postgres. Hand-written, deterministic.

/** 2026-10-24T15:00:00Z. */
export const RUNTIMES_NOW = 1_792_854_000_000

export const RUNTIMES_SERVICE = "fleet-api"

const MINUTE = 60_000
const BUCKETS = 60
const iso = (ms: number) => new Date(ms).toISOString()
const start = RUNTIMES_NOW - BUCKETS * MINUTE
/** A smooth, repeatable wobble in [-1, 1] per bucket. */
const wobble = (index: number, phase: number) =>
	Math.sin(index / 4 + phase) * 0.6 + Math.sin(index / 1.7 + phase * 2) * 0.4

/** The bucket 9b2f0d1 was first seen in: from here the error rate holds near 1.4%. */
const DEPLOY_INDEX = 39

export const RUNTIMES_POINTS: ReadonlyArray<DetailPoint> = Array.from({ length: BUCKETS }, (_, index) => {
	// The chart divides `throughput` by the bucket seconds: it is the bucket's request count.
	const throughput = Math.round((42 + wobble(index, 0.3) * 6 + (index > 38 ? 4 : 0)) * 60)
	const baseRate = 0.002 + Math.max(0, wobble(index, 1.1)) * 0.002
	const errorRate =
		index === 41 || index === 42 ? 0.021 : index >= DEPLOY_INDEX ? baseRate + 0.011 : baseRate
	const p50 = 18 + wobble(index, 2) * 2
	return {
		bucket: iso(start + index * MINUTE),
		throughput,
		tracedThroughput: throughput,
		hasSampling: false,
		samplingWeight: 1,
		errorRate,
		p50LatencyMs: p50,
		p95LatencyMs: p50 * 3.1 + (index === 41 ? 60 : 0),
		p99LatencyMs: p50 * 6.4 + (index === 41 ? 180 : 0),
		apdexScore: index === 41 ? 0.91 : 0.985,
		totalCount: throughput,
		partial: index === BUCKETS - 1,
	}
})

const SHA_OLD = "c41e7a2d9f03b8e61c7a5d2e4f9b0c13a6e8d571"
/** The deploy that raised errors: the lab opens its drawer with `?deploy=`. */
export const SHA_DEPLOY = "9b2f0d1e47c6a3b90f2d8e15c4a7b6d3e09f1c28"

/** The build running at the window start, then one Cloud Run revision rolled out at 14:39. */
export const RUNTIMES_RELEASES: ReadonlyArray<Release> = [
	{ bucket: iso(start), commitSha: SHA_OLD, count: 95_000, errorCount: 190 },
	{ bucket: iso(start + 39 * MINUTE), commitSha: SHA_DEPLOY, count: 58_000, errorCount: 210 },
]

const sumOf = (values: ReadonlyArray<number>) => Arr.reduce(values, 0, (acc, value) => acc + value)

/** One side of the deploy, read off the chart buckets the way the warehouse sums the minutes. */
const sideOf = (from: number, to: number) => {
	const points = RUNTIMES_POINTS.slice(from, to)
	const p95s = Arr.sort(
		Arr.map(points, (point) => point.p95LatencyMs),
		Order.Number,
	)
	return {
		spans: sumOf(Arr.map(points, (point) => point.totalCount)),
		errors: Math.round(sumOf(Arr.map(points, (point) => point.totalCount * point.errorRate))),
		p95: p95s[Math.floor(p95s.length * 0.95)] ?? 0,
	}
}

const before = sideOf(DEPLOY_INDEX - 30, DEPLOY_INDEX)
const after = sideOf(DEPLOY_INDEX, BUCKETS)

/** 9b2f0d1, 21 minutes in: errors up from about 0.3% to 1.4%. c41e7a2 predates the window. */
export const RUNTIMES_DEPLOYS: ServiceDeploys = {
	deploys: [
		{
			serviceName: RUNTIMES_SERVICE,
			environment: "production",
			commitSha: SHA_DEPLOY,
			firstSeen: iso(start + DEPLOY_INDEX * MINUTE),
			afterSpans: after.spans,
			afterErrors: after.errors,
			afterP95Ms: after.p95,
			beforeSpans: before.spans,
			beforeErrors: before.errors,
			beforeP95Ms: before.p95,
		},
	],
	verifyWindowSeconds: 1800,
	readUntil: iso(RUNTIMES_NOW),
}

/** The same commit also went to fleet-web, which took it cleanly. */
export const RUNTIMES_SHIPPED: ServiceDeploys = {
	deploys: [
		...RUNTIMES_DEPLOYS.deploys,
		{
			serviceName: "fleet-web",
			environment: "production",
			commitSha: SHA_DEPLOY,
			firstSeen: iso(start + (DEPLOY_INDEX + 2) * MINUTE),
			afterSpans: 18_400,
			afterErrors: 20,
			afterP95Ms: 140,
			beforeSpans: 27_100,
			beforeErrors: 30,
			beforeP95Ms: 138,
		},
	],
	verifyWindowSeconds: 1800,
	readUntil: iso(RUNTIMES_NOW),
}

export const RUNTIMES_COMMITS: ReadonlyMap<string, Commit> = new Map([
	[
		SHA_OLD,
		{
			sha: SHA_OLD,
			message: "fleet: batch vehicle position writes",
			authorName: "Ines Duarte",
			authorLogin: "ines-d",
			authorAvatarUrl: null,
			committedAt: RUNTIMES_NOW - 26 * 60 * MINUTE,
		},
	],
	[
		SHA_DEPLOY,
		{
			sha: SHA_DEPLOY,
			message: "routes: cache depot lookups for 30s",
			authorName: "Kenji Arai",
			authorLogin: "karai",
			authorAvatarUrl: null,
			committedAt: RUNTIMES_NOW - 52 * MINUTE,
		},
	],
])

const sparkline = (base: number, phase: number) =>
	Array.from({ length: 30 }, (_, index) => ({
		bucket: iso(start + index * 2 * MINUTE),
		count: Math.round(base * (1 + wobble(index, phase) * 0.25)),
	}))

const operation = (
	spanName: string,
	spanCount: number,
	errorCount: number,
	p50: number,
	p95: number,
	phase: number,
): Operation => ({
	spanName,
	spanCount,
	estimatedSpanCount: spanCount,
	errorCount,
	estimatedErrorCount: errorCount,
	errorRate: errorCount / spanCount,
	avgDurationMs: p50 * 1.4,
	p50DurationMs: p50,
	p95DurationMs: p95,
	sparkline: sparkline(spanCount / 30, phase),
})

export const RUNTIMES_OPERATIONS: ReadonlyArray<Operation> = [
	operation("GET /v1/vehicles/{id}/position", 71_400, 38, 9.2, 31.5, 0.2),
	operation("POST /v1/positions:batch", 42_150, 112, 24.8, 88.1, 1.4),
	operation("GET /v1/routes/{id}", 18_920, 9, 14.1, 52.7, 2.1),
	operation("GET /v1/depots", 7_310, 0, 4.3, 11.9, 0.7),
	operation("PATCH /v1/vehicles/{id}", 3_080, 27, 31.6, 140.2, 2.9),
	operation("GET /healthz", 3_600, 0, 0.4, 1.1, 0.1),
]

/** The deploy drawer's sides: the batch write starts failing, the depot read gets its cache. */
export const RUNTIMES_DEPLOY_BEFORE: ReadonlyArray<Operation> = [
	operation("GET /v1/vehicles/{id}/position", 35_600, 18, 9.2, 31.5, 0.2),
	operation("POST /v1/positions:batch", 21_000, 42, 24.8, 86.4, 1.4),
	operation("GET /v1/routes/{id}", 9_400, 4, 14.1, 52.7, 2.1),
	operation("GET /v1/depots", 3_650, 0, 4.3, 38.9, 0.7),
	operation("PATCH /v1/vehicles/{id}", 1_540, 13, 31.6, 140.2, 2.9),
]

export const RUNTIMES_DEPLOY_AFTER: ReadonlyArray<Operation> = [
	operation("GET /v1/vehicles/{id}/position", 25_100, 13, 9.4, 32.1, 0.2),
	operation("POST /v1/positions:batch", 14_800, 1_480, 26.1, 131.0, 1.4),
	operation("GET /v1/routes/{id}", 6_620, 3, 14.0, 51.9, 2.1),
	operation("GET /v1/depots", 2_570, 0, 1.1, 3.2, 0.7),
	operation("PATCH /v1/vehicles/{id}", 1_090, 9, 31.0, 138.7, 2.9),
	operation("GET /v1/depots/{id}/cache", 410, 0, 0.6, 1.4, 0.4),
]

export const RUNTIMES_ISSUES: ReadonlyArray<Issue> = [
	{
		id: "iss_fleet_01",
		title: "pgconn: deadlock detected (SQLSTATE 40P01) in UpsertPositions",
		severity: "high",
		occurrenceCount: 64,
		firstSeenAt: iso(start + 41 * MINUTE),
		lastSeenAt: iso(RUNTIMES_NOW - 2 * MINUTE),
	},
	{
		id: "iss_fleet_02",
		title: "context deadline exceeded calling routing.Optimize",
		severity: "medium",
		occurrenceCount: 11,
		firstSeenAt: iso(RUNTIMES_NOW - 3 * 24 * 60 * MINUTE),
		lastSeenAt: iso(RUNTIMES_NOW - 44 * MINUTE),
	},
]

export const RUNTIMES_USAGE: Usage = {
	totals: { logs: 412_600, traces: 151_480, metrics: 96_200, dataSize: 1_284_000_000 },
	previous: { logs: 398_100, traces: 144_900, metrics: 96_050, dataSize: 1_221_000_000 },
}

/** fleet-api runs on Cloud Run: the Kubernetes read finds nothing. */
export const RUNTIMES_WORKLOADS: ReadonlyArray<Workload> = []

/** `fleet-api` runs as a Cloud Run service in one region. */
export const RUNTIMES_RUNTIMES: ReadonlyArray<ServiceRuntime> = [
	{
		serviceName: Schema.decodeSync(ServiceName)("fleet-api"),
		kind: "cloudRun",
		account: "fleet-prod",
		region: "europe-west1",
		cluster: "",
		railwayServiceId: "",
		railwayEnvironmentId: "",
		railwayEnvironmentName: "",
		vercelProjectId: "",
	},
]

const edgeStats = (callCount: number, errorCount: number, avgDurationMs: number, maxDurationMs: number) => ({
	callCount,
	estimatedCallCount: callCount,
	errorCount,
	errorRate: errorCount / callCount,
	avgDurationMs,
	maxDurationMs,
	hasSampling: false,
	samplingWeight: 1,
})

export const RUNTIMES_DEPENDENCIES: DependencyBundle = {
	/** fleet-api calls no other traced service; its callers are not dependencies. */
	serviceEdges: [],
	dbEdges: [
		{
			sourceService: RUNTIMES_SERVICE,
			dbSystem: "postgresql",
			dbNamespace: "fleet",
			p95DurationMs: 12.6,
			...edgeStats(186_400, 64, 3.8, 840),
		},
	],
	externalEdges: [
		{
			sourceService: RUNTIMES_SERVICE,
			targetType: "http",
			targetSystem: "http",
			targetName: "routes.googleapis.com",
			p95DurationMs: 212.4,
			...edgeStats(2_310, 11, 96.2, 3_020),
		},
	],
}

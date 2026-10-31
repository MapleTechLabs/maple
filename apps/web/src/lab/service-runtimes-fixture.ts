import { ServiceName } from "@maple/domain/http"
import { Schema } from "effect"
import type { ServiceRuntime } from "../page/kit/service-runtimes"
import type { Commit, DetailPoint, Issue, Release, Usage, Workload } from "../page/services/detail/model"
import type { DependencyBundle, Operation } from "../page/services/detail/model-tabs"

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

export const RUNTIMES_POINTS: ReadonlyArray<DetailPoint> = Array.from({ length: BUCKETS }, (_, index) => {
	// The chart divides `throughput` by the bucket seconds: it is the bucket's request count.
	const throughput = Math.round((42 + wobble(index, 0.3) * 6 + (index > 38 ? 4 : 0)) * 60)
	const errorRate = index === 41 || index === 42 ? 0.021 : 0.002 + Math.max(0, wobble(index, 1.1)) * 0.002
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

/** The build running at the window start, then one Cloud Run revision rolled out at 14:39. */
export const RUNTIMES_RELEASES: ReadonlyArray<Release> = [
	{ bucket: iso(start), commitSha: "c41e7a2", count: 95_000, errorCount: 190 },
	{ bucket: iso(start + 39 * MINUTE), commitSha: "9b2f0d1", count: 58_000, errorCount: 210 },
]

export const RUNTIMES_COMMITS: ReadonlyMap<string, Commit> = new Map([
	[
		"c41e7a2",
		{
			sha: "c41e7a2",
			message: "fleet: batch vehicle position writes",
			authorName: "Ines Duarte",
			authorLogin: "ines-d",
			authorAvatarUrl: null,
			committedAt: RUNTIMES_NOW - 26 * 60 * MINUTE,
		},
	],
	[
		"9b2f0d1",
		{
			sha: "9b2f0d1",
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

export const RUNTIMES_ISSUES: ReadonlyArray<Issue> = [
	{
		id: "iss_fleet_01",
		title: "pgconn: deadlock detected (SQLSTATE 40P01) in UpsertPositions",
		severity: "error",
		occurrenceCount: 64,
		lastSeenAt: iso(RUNTIMES_NOW - 17 * MINUTE),
	},
	{
		id: "iss_fleet_02",
		title: "context deadline exceeded calling routing.Optimize",
		severity: "warning",
		occurrenceCount: 11,
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

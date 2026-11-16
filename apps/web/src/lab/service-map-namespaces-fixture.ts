import type { MapBundle } from "../page/service-map/model"

// `/lab/service-map-runtimes?topology=namespaces`: two namespaces over one hour. `orders` is read
// only from `shop`, `ledger` only from `billing`, and the shared Redis cache from both.

const DURATION_SECONDS = 3600

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

const overview = (serviceName: string, serviceNamespace: string, spanCount: number, p50: number) => ({
	serviceName,
	serviceNamespace,
	environment: "production",
	commits: [],
	p50LatencyMs: p50,
	p95LatencyMs: p50 * 3.2,
	p99LatencyMs: p50 * 6.5,
	errorRate: 0.0014,
	throughput: spanCount / DURATION_SECONDS,
	tracedThroughput: spanCount / DURATION_SECONDS,
	hasSampling: false,
	samplingWeight: 1,
	spanCount,
})

const dbEdge = (sourceService: string, dbSystem: string, dbNamespace: string, callCount: number) => ({
	sourceService,
	dbSystem,
	dbNamespace,
	p95DurationMs: 9.4,
	...edgeStats(callCount, 12, 2.6, 410),
})

export const MAP_NAMESPACES_BUNDLE: MapBundle["value"] = {
	edges: [
		{ sourceService: "shop-web", targetService: "shop-api", ...edgeStats(88_400, 96, 24.1, 980) },
		{ sourceService: "shop-api", targetService: "billing-api", ...edgeStats(21_300, 18, 31.7, 1_120) },
		{ sourceService: "billing-api", targetService: "billing-worker", ...edgeStats(9_800, 4, 12.2, 640) },
	],
	dbEdges: [
		dbEdge("shop-api", "postgresql", "orders", 142_600),
		dbEdge("shop-api", "redis", "cache", 310_200),
		dbEdge("billing-api", "redis", "cache", 64_900),
		dbEdge("billing-worker", "postgresql", "ledger", 27_400),
	],
	dbEdgesTimedOut: false,
	overview: [
		overview("shop-web", "shop", 112_300, 38),
		overview("shop-api", "shop", 134_800, 16),
		overview("billing-api", "billing", 31_200, 22),
		overview("billing-worker", "billing", 10_400, 41),
	],
	platforms: [],
	workloads: [],
	runtimes: [],
}

// Input rows the service map is built from. Each host (cloud web app, Maple
// Local) maps its own query results onto these shapes, so the map itself never
// learns which backend answered.

export type ServicePlatform = "kubernetes" | "cloudflare" | "lambda" | "web" | "unknown"

/** One service-to-service edge over the window. */
export interface ServiceMapEdgeRow {
	sourceService: string
	targetService: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	/** Slowest call in the window, not a percentile. */
	maxDurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

/** One service-to-database edge; `dbNamespace` is "" when the database is unidentified. */
export interface ServiceMapDbEdgeRow {
	sourceService: string
	dbSystem: string
	dbNamespace: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	/** Slowest call in the window, not a percentile. */
	maxDurationMs: number
	/** Sample-weighted p95 in ms; 0 when the window has no digest to merge. */
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

/** The per-service stats a node renders (a subset of the services-list overview row). */
export interface ServiceMapOverviewRow {
	serviceName: string
	serviceNamespace: string
	/** Requests per second, sampling-corrected when the data carries a weight. */
	throughput: number
	/** Requests per second, stored spans only. */
	tracedThroughput: number
	hasSampling: boolean
	samplingWeight: number
	errorRate: number
	p50LatencyMs: number
}

/** A Kubernetes workload a service runs as. */
export interface ServiceMapWorkloadRow {
	serviceName: string
	podCount: number
}

/** Cloudflare Worker analytics, overlaid onto the matching instrumented service. */
export interface ServiceMapCloudflareRow {
	kind: "worker"
	/** Worker script name. */
	displayName: string
	requests: number
	errorRate: number
	/** Wall-time duration p99. */
	latencyP99Ms: number
	/** CPU time p99. */
	cpuP99Ms?: number
}

/** PlanetScale scraped-metric rollup for one database. */
export interface PlanetScaleDatabaseStat {
	database: string
	connectionsAvg: number
	connectionsMax: number
	cpuMaxPercent: number
	memMaxPercent: number
	replicaLagMaxSeconds: number
	/** Worst branch's disk usage (0-100), or null when no volume gauge reported in the window. */
	storageUsedPercent: number | null
}

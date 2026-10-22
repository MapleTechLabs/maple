import type { ServiceOverview } from "@maple/query-engine"
import type {
	ServiceMapDbEdgeRow,
	ServiceMapEdgeRow,
	ServicePlatform,
} from "@maple/ui/components/service-map/service-map-types"
import { Schema } from "effect"
import { cachedAs } from "../../data/cached"

// The service map's data as Schemas, so the map
// goes through the result cache like the other pages. Each mirrors the shared row type it decodes.

export const EdgeRow = Schema.Struct({
	sourceService: Schema.String,
	targetService: Schema.String,
	callCount: Schema.Number,
	estimatedCallCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	maxDurationMs: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
})

export const DbEdgeRow = Schema.Struct({
	sourceService: Schema.String,
	dbSystem: Schema.String,
	dbNamespace: Schema.String,
	callCount: Schema.Number,
	estimatedCallCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	maxDurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
})

const CommitBreakdown = Schema.Struct({
	commitSha: Schema.String,
	spanCount: Schema.Number,
	percentage: Schema.Number,
	errorCount: Schema.Number,
	firstSeen: Schema.String,
})

export const OverviewRow = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	environment: Schema.String,
	commits: Schema.Array(CommitBreakdown),
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	errorRate: Schema.Number,
	throughput: Schema.Number,
	tracedThroughput: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
	spanCount: Schema.Number,
})

export const Platform = Schema.Literals(["kubernetes", "cloudflare", "gcp", "lambda", "web", "unknown"])

export const LocalServiceMapData = Schema.Struct({
	edges: Schema.Array(EdgeRow),
	dbEdges: Schema.Array(DbEdgeRow),
	/** One row per (service, environment), sampling-corrected like the cloud map's. */
	overviews: Schema.Array(OverviewRow),
	platforms: Schema.ReadonlyMap(Schema.String, Platform),
	/** `process.runtime.name` per service. */
	runtimes: Schema.ReadonlyMap(Schema.String, Schema.String),
})
export type LocalServiceMapData = typeof LocalServiceMapData.Type

/** The rows `buildSourceGraph` takes; building them type-checks the Schemas against the shared types. */
export const graphRowsOf = (
	data: LocalServiceMapData,
): Readonly<{
	edges: Array<ServiceMapEdgeRow>
	dbEdges: Array<ServiceMapDbEdgeRow>
	serviceOverviews: Array<ServiceOverview>
	platforms: Map<string, ServicePlatform>
	runtimes: Map<string, string>
}> => ({
	edges: data.edges.map((row) => ({ ...row })),
	dbEdges: data.dbEdges.map((row) => ({ ...row })),
	serviceOverviews: data.overviews.map((row) => ({
		...row,
		commits: row.commits.map((commit) => ({ ...commit })),
	})),
	platforms: new Map(data.platforms),
	runtimes: new Map(data.runtimes),
})

/** The saved map as this build reads it, or none for an older build's shape. */
export const mapFromCached = cachedAs(LocalServiceMapData)

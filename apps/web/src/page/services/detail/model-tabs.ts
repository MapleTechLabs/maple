import { Schema } from "effect"

// Row schemas of the Operations, API and Dependencies data (mirroring the web-data types).

/** The three sortable tables of the tabs. */
export const SortTable = Schema.Literals(["operations", "endpoints", "dependencies"])
export type SortTable = typeof SortTable.Type

/** `ServiceOperation` (@maple/web-data/warehouse/service-operations). */
export const Operation = Schema.Struct({
	spanName: Schema.String,
	spanCount: Schema.Number,
	estimatedSpanCount: Schema.Number,
	errorCount: Schema.Number,
	estimatedErrorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	sparkline: Schema.Array(Schema.Struct({ bucket: Schema.String, count: Schema.Number })),
})
export type Operation = typeof Operation.Type

/** `ServiceEndpoint` (@maple/web-data/warehouse/service-endpoints). */
export const Endpoint = Schema.Struct({
	spanName: Schema.String,
	method: Schema.String,
	route: Schema.String,
	spanCount: Schema.Number,
	estimatedSpanCount: Schema.Number,
	errorCount: Schema.Number,
	estimatedErrorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	p99DurationMs: Schema.Number,
	httpClassifiedSpanCount: Schema.Number,
	httpStatusCount: Schema.Number,
	http4xxCount: Schema.Number,
	http5xxCount: Schema.Number,
	requestBodyBytes: Schema.Number,
	requestBodyCount: Schema.Number,
})
export type Endpoint = typeof Endpoint.Type

const EdgeStats = {
	callCount: Schema.Number,
	estimatedCallCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	maxDurationMs: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
}

/** `ServiceEdge` (service-map.ts). */
export const ServiceEdge = Schema.Struct({
	sourceService: Schema.String,
	targetService: Schema.String,
	...EdgeStats,
})
export type ServiceEdge = typeof ServiceEdge.Type

/** `ServiceDbEdge` (service-map.ts). */
export const DbEdge = Schema.Struct({
	sourceService: Schema.String,
	dbSystem: Schema.String,
	dbNamespace: Schema.String,
	p95DurationMs: Schema.Number,
	...EdgeStats,
})
export type DbEdge = typeof DbEdge.Type

/** `ServiceExternalEdge` (service-external-edges.ts). */
export const ExternalEdge = Schema.Struct({
	sourceService: Schema.String,
	targetType: Schema.Literals(["http", "messaging", "rpc"]),
	targetSystem: Schema.String,
	targetName: Schema.String,
	p95DurationMs: Schema.Number,
	...EdgeStats,
})
export type ExternalEdge = typeof ExternalEdge.Type

/** `getServiceDependenciesBundle`'s answer. */
export const DependencyBundle = Schema.Struct({
	serviceEdges: Schema.Array(ServiceEdge),
	dbEdges: Schema.Array(DbEdge),
	externalEdges: Schema.Array(ExternalEdge),
})
export type DependencyBundle = typeof DependencyBundle.Type

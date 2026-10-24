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
	/** Spans in buckets written after the status counters existed; below `spanCount` the mix is partial. */
	httpClassifiedSpanCount: Schema.Number,
	httpStatusCount: Schema.Number,
	http4xxCount: Schema.Number,
	http5xxCount: Schema.Number,
	requestBodyBytes: Schema.Number,
	requestBodyCount: Schema.Number,
})
export type Endpoint = typeof Endpoint.Type

/** `ServiceApiTotals`: every HTTP endpoint of the service merged. */
export const ApiTotals = Schema.Struct({
	spanCount: Schema.Number,
	estimatedSpanCount: Schema.Number,
	httpClassifiedSpanCount: Schema.Number,
	httpStatusCount: Schema.Number,
	http4xxCount: Schema.Number,
	http5xxCount: Schema.Number,
	requestBodyBytes: Schema.Number,
	requestBodyCount: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	p99DurationMs: Schema.Number,
})
export type ApiTotals = typeof ApiTotals.Type

/** `ServiceApiBucket`: one bucket of one endpoint, or of all of them when `spanName` is empty. */
export const ApiBucket = Schema.Struct({
	bucket: Schema.String,
	spanName: Schema.String,
	estimatedSpanCount: Schema.Number,
	/** 0 when the bucket predates the status counters: its status mix is unknown. */
	httpClassifiedSpanCount: Schema.Number,
	httpStatusCount: Schema.Number,
	http4xxCount: Schema.Number,
	http5xxCount: Schema.Number,
	requestBodyBytes: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	p99DurationMs: Schema.Number,
})
export type ApiBucket = typeof ApiBucket.Type

/** `getServiceApiOverview`'s answer: the KPI strip and the responses chart. */
export const ApiOverview = Schema.Struct({
	totals: ApiTotals,
	previous: Schema.NullOr(ApiTotals),
	buckets: Schema.Array(ApiBucket),
})
export type ApiOverview = typeof ApiOverview.Type

/** `ServiceEndpointStatusRow`: one (endpoint, status code, error.type) of the window. */
export const StatusRow = Schema.Struct({
	spanName: Schema.String,
	httpStatusCode: Schema.String,
	errorType: Schema.String,
	spanCount: Schema.Number,
	estimatedSpanCount: Schema.Number,
})
export type StatusRow = typeof StatusRow.Type

/** `ServiceEndpointDetail`: the drawer's distribution, body sizes, clients and slowest requests. */
export const EndpointDetail = Schema.Struct({
	latencyQuantileLevels: Schema.Array(Schema.Number),
	latencyQuantilesMs: Schema.Array(Schema.Number),
	body: Schema.NullOr(
		Schema.Struct({
			p50Bytes: Schema.Number,
			p95Bytes: Schema.Number,
			maxBytes: Schema.Number,
			count: Schema.Number,
		}),
	),
	userAgents: Schema.Array(Schema.Struct({ value: Schema.String, count: Schema.NullOr(Schema.Number) })),
	slowest: Schema.Array(
		Schema.Struct({
			traceId: Schema.String,
			timestamp: Schema.String,
			durationMs: Schema.Number,
			httpStatusCode: Schema.String,
			bodyBytes: Schema.NullOr(Schema.Number),
		}),
	),
})
export type EndpointDetail = typeof EndpointDetail.Type

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

import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SOURCE_IDS } from "@maple/domain/gcp-infra"
import {
	GcpCloudSqlTopQueriesResponse,
	GcpInfraTimeseriesResponse,
	GcpResourcesResponse,
} from "@maple/domain/http"
import { V2GcpIntegration } from "@maple/domain/http/v2"
import {
	getGcpCloudSqlStatementSpans,
	getGcpCloudSqlTopQueries,
	getGcpCloudSqlTraceSide,
	getGcpInfraFleet,
	getGcpInfraSparklines,
	getGcpInfraTimeseries,
} from "@maple/web-data/warehouse/gcp-infra"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// The Google Cloud reads, as Effects the pages wrap in their own Commands.

export const GcpStatus = V2GcpIntegration
export type GcpStatus = V2GcpIntegration
export const Resources = GcpResourcesResponse
export type Resources = GcpResourcesResponse

export const ServiceId = Schema.Literals(GCP_INFRA_SERVICE_IDS)

/** `GcpFleetRead`: one service's metric points, or that its read failed. */
export const FleetRead = Schema.Struct({
	service: ServiceId,
	points: Schema.Array(
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			metric: Schema.String,
			label: Schema.String,
			total: Schema.Number,
			samples: Schema.Number,
		}),
	),
	failed: Schema.Boolean,
})
export type FleetRead = typeof FleetRead.Type

export const SparkRead = Schema.Struct({
	service: ServiceId,
	points: Schema.Array(
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			bucket: Schema.String,
			metric: Schema.String,
			total: Schema.Number,
			samples: Schema.Number,
		}),
	),
})
export type SparkRead = typeof SparkRead.Type

/** `gcpStatusQuery()`, shared with the sidebar. */
export const loadStatus = (refresh: boolean) =>
	Effect.gen(function* () {
		const statuses = yield* IntegrationStatuses
		return yield* statuses.gcp({ refresh })
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `gcpInfraFleetResultAtom({ data: window })`: presence, then every reporting service's metrics. */
export const loadFleet = (window: TimeWindow) =>
	getGcpInfraFleet({ data: window }).pipe(
		Effect.map((response): ReadonlyArray<FleetRead> => response.services),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const SparksInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	services: Schema.Array(ServiceId),
})
export type SparksInput = typeof SparksInput.Type

/** `gcpInfraSparklinesResultAtom`. */
export const loadSparks = (input: SparksInput) =>
	getGcpInfraSparklines({ data: input }).pipe(
		Effect.map((response): ReadonlyArray<SparkRead> => response.services),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const ResourcesQuery = Schema.Struct({
	assetType: Schema.optionalKey(Schema.String),
	projectId: Schema.optionalKey(Schema.String),
})
export type ResourcesQuery = typeof ResourcesQuery.Type

/** `retainedInternalQuery("integrations", "gcpResources", { query })`. */
export const loadResources = (query: ResourcesQuery) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.gcpResources({ query })
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const BucketPoint = GcpInfraTimeseriesResponse.fields.data.value
export type BucketPoint = typeof BucketPoint.Type

export const TimeseriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	source: Schema.Literals(GCP_INFRA_SOURCE_IDS),
	keys: Schema.Array(Schema.String),
})
export type TimeseriesInput = typeof TimeseriesInput.Type

/** `gcpInfraTimeseriesResultAtom`: one source's points for one workload (or cluster). */
export const loadTimeseries = (input: TimeseriesInput) =>
	getGcpInfraTimeseries({ data: { ...input, keys: [...input.keys] } }).pipe(
		Effect.map((response): ReadonlyArray<BucketPoint> => response.points),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const Statement = GcpCloudSqlTopQueriesResponse.fields.data.value
export type Statement = typeof Statement.Type

export const CloudSqlInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	keys: Schema.Array(Schema.String),
})
export type CloudSqlInput = typeof CloudSqlInput.Type

export const loadTopQueries = (input: CloudSqlInput) =>
	getGcpCloudSqlTopQueries({ data: { ...input, keys: [...input.keys] } }).pipe(
		Effect.map((response): ReadonlyArray<Statement> => response.statements),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const TraceSide = Schema.Struct({
	databases: Schema.Array(Schema.String),
	tracedQueries: Schema.Array(
		Schema.Struct({
			queryKey: Schema.String,
			sampleStatement: Schema.String,
			sampleService: Schema.String,
			serviceCount: Schema.Number,
			estimatedQueryCount: Schema.Number,
			p95DurationMs: Schema.Number,
		}),
	),
	services: Schema.Number,
})
export type TraceSide = typeof TraceSide.Type

export const loadTraceSide = (input: CloudSqlInput) =>
	getGcpCloudSqlTraceSide({ data: { ...input, keys: [...input.keys] } }).pipe(
		Effect.map((response): TraceSide => ({
			databases: response.databases,
			tracedQueries: response.tracedQueries.map((query) => ({
				queryKey: query.queryKey,
				sampleStatement: query.sampleStatement,
				sampleService: query.sampleService,
				serviceCount: query.serviceCount,
				estimatedQueryCount: query.estimatedQueryCount,
				p95DurationMs: query.p95DurationMs,
			})),
			services: response.services,
		})),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** One client span of a statement's traced shapes: see `serviceDbQuerySpansSQL`. */
export const StatementSpan = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	serviceName: Schema.String,
	timestamp: Schema.String,
	durationMs: Schema.Number,
})
export type StatementSpan = typeof StatementSpan.Type

export const StatementSpansInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	databases: Schema.Array(Schema.String),
	queryKeys: Schema.Array(Schema.String),
})
export type StatementSpansInput = typeof StatementSpansInput.Type

/** The slowest spans of a statement's traced shapes against the instance's databases. */
export const loadStatementSpans = (input: StatementSpansInput) =>
	getGcpCloudSqlStatementSpans({
		data: { ...input, databases: [...input.databases], queryKeys: [...input.queryKeys] },
	}).pipe(
		Effect.map((response): ReadonlyArray<StatementSpan> => response.spans),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** The entry spans the trace-gap callout counts errors on: `ServiceOverview`'s fields it reads. */
export const OverviewRow = Schema.Struct({
	serviceName: Schema.String,
	errorRate: Schema.Number,
	throughput: Schema.Number,
})
export type OverviewRow = typeof OverviewRow.Type

export const OverviewInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type OverviewInput = typeof OverviewInput.Type

/** `getServiceOverviewResultAtom({ data: window })`, the org namespace pin applied. */
export const loadOverview = (input: OverviewInput) =>
	getServiceOverview({
		data:
			input.namespaces === undefined
				? { startTime: input.startTime, endTime: input.endTime }
				: { ...input, namespaces: [...input.namespaces] },
	}).pipe(
		Effect.map((response): ReadonlyArray<OverviewRow> =>
			response.data.map((row) => ({
				serviceName: row.serviceName,
				errorRate: row.errorRate,
				throughput: row.throughput,
			})),
		),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

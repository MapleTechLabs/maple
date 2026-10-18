import { GCP_INFRA_SERVICE_IDS, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { GcpResourcesResponse } from "@maple/domain/http"
import { V2GcpIntegration } from "@maple/domain/http/v2"
import { getGcpInfraFleet, getGcpInfraSparklines } from "@maple/web-data/warehouse/gcp-infra"
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

export type { GcpInfraServiceId }

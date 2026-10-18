import { getServiceMapPlanetScale } from "@maple/web-data/warehouse/service-map"
import { V2PlanetScaleDatabaseList, V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The PlanetScale reads both pages share, as Effects each page wraps in its own Commands.

export const PlanetscaleStatus = V2PlanetScaleIntegration
export type PlanetscaleStatus = V2PlanetScaleIntegration
export const DatabaseList = V2PlanetScaleDatabaseList
export type DatabaseList = V2PlanetScaleDatabaseList

/** `PlanetScaleDatabaseStat` (`@maple/web-data/warehouse/service-map`). */
export const DatabaseStat = Schema.Struct({
	database: Schema.String,
	connectionsAvg: Schema.Number,
	connectionsMax: Schema.Number,
	cpuMaxPercent: Schema.Number,
	memMaxPercent: Schema.Number,
	replicaLagMaxSeconds: Schema.Number,
	storageUsedPercent: Schema.NullOr(Schema.Number),
})
export type DatabaseStat = typeof DatabaseStat.Type

/** `retainedQueryV2("planetscaleIntegration", "status")`, shared with the sidebar. */
export const loadStatus = (refresh: boolean) =>
	Effect.gen(function* () {
		const statuses = yield* IntegrationStatuses
		return yield* statuses.planetscale({ refresh })
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `retainedQueryV2("planetscaleIntegration", "databases")`. */
export const loadDatabases = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* client.planetscaleIntegration.databases()
}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `getServiceMapPlanetScaleResultAtom({ data: window })`. */
export const loadDatabaseStats = (window: TimeWindow) =>
	getServiceMapPlanetScale({ data: window }).pipe(
		Effect.map((response): ReadonlyArray<DatabaseStat> => response.databases),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

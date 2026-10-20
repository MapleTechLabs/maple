import {
	getPlanetScaleEvents,
	getPlanetScaleInfraTimeseries,
	getPlanetScaleQueryInsights,
} from "@maple/web-data/warehouse/planetscale-infra"
import { getPlanetScaleBranchStats, getServiceMapPlanetScale } from "@maple/web-data/warehouse/service-map"
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

export const BranchStat = Schema.Struct({ ...DatabaseStat.fields, branch: Schema.String })
export type BranchStat = typeof BranchStat.Type

export const TimeseriesRow = Schema.Struct({
	bucket: Schema.String,
	connectionsAvg: Schema.Number,
	cpuMaxPercent: Schema.Number,
	memMaxPercent: Schema.Number,
	replicaLagMaxSeconds: Schema.Number,
	storageUsedPercent: Schema.NullOr(Schema.Number),
})
export type TimeseriesRow = typeof TimeseriesRow.Type

export const EventEntry = Schema.Struct({
	id: Schema.String,
	databaseName: Schema.String,
	branchName: Schema.String,
	category: Schema.String,
	eventType: Schema.String,
	state: Schema.NullOr(Schema.String),
	externalId: Schema.String,
	title: Schema.String,
	source: Schema.String,
	actorLogin: Schema.NullOr(Schema.String),
	url: Schema.NullOr(Schema.String),
	occurredAt: Schema.Number,
})
export type EventEntry = typeof EventEntry.Type

export const QueryInsight = Schema.Struct({
	fingerprint: Schema.String,
	normalizedSql: Schema.String,
	statementType: Schema.NullOr(Schema.String),
	queryCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	totalDurationMillis: Schema.Number,
	timePerQueryMillis: Schema.Number,
	p50LatencyMillis: Schema.Number,
	p99LatencyMillis: Schema.Number,
	rowsReadPerQuery: Schema.Number,
	lastRunAt: Schema.NullOr(Schema.Number),
})
export const QueryInsights = Schema.Struct({
	branch: Schema.String,
	unavailableReason: Schema.NullOr(Schema.String),
	rows: Schema.Array(QueryInsight),
})
export type QueryInsights = typeof QueryInsights.Type

/** `getPlanetScaleBranchStatsResultAtom`. */
export const loadBranchStats = (input: TimeWindow & { readonly database: string }) =>
	getPlanetScaleBranchStats({ data: input }).pipe(
		Effect.map((response): ReadonlyArray<BranchStat> => response.branches),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const TimeseriesInput = Schema.Struct({
	database: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	branch: Schema.optionalKey(Schema.String),
})
export type TimeseriesInput = typeof TimeseriesInput.Type

export const loadTimeseries = (input: TimeseriesInput) =>
	getPlanetScaleInfraTimeseries({ data: input }).pipe(
		Effect.map((response): ReadonlyArray<TimeseriesRow> => response.buckets),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const EpochWindowInput = Schema.Struct({
	database: Schema.String,
	startTime: Schema.Number,
	endTime: Schema.Number,
	branch: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Number),
})
export type EpochWindowInput = typeof EpochWindowInput.Type

export const loadEvents = (input: EpochWindowInput) =>
	getPlanetScaleEvents({ data: input }).pipe(
		Effect.map((response): ReadonlyArray<EventEntry> => response.events),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const loadInsights = (input: EpochWindowInput) =>
	getPlanetScaleQueryInsights({ data: input }).pipe(
		Effect.map((response): QueryInsights => response),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

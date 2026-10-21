import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import {
	getPlanetScaleBranchStats,
	getServiceDbQuerySummary,
	getServiceMapBundle,
	getServiceMapCloudflare,
	getServiceMapPlanetScale,
} from "@maple/web-data/warehouse/service-map"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { loadServicesFacets } from "../../data/services-facets-probe"
import { toLoadFailure } from "../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../data/time-range"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Snapshot, ViewPrefs } from "../../service-map/map/state"
import { loadSignalPresences } from "../kit/signal-presence"
import { Message, RequestMode } from "./message"
import {
	BranchStats,
	CloudflareStats,
	DbSummary,
	MapBundle,
	PlanetScaleStats,
	Stored as StoredSchema,
} from "./model"

const FACETS_RANGE_MS = 24 * 60 * 60 * 1000

/**
 * `useEffectiveTimeRange` (snapped on entry, against the real clock after a Reload) and the
 * environment dropdown's fixed 24 h `facetsRange`, snapped to the cache grid, at one clock read.
 */
export const ResolveWindow = Command.define("ResolveServiceMapWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				timeZone,
				facetsWindow: snapRangeForCache({
					startTime: formatWarehouseDateTime(nowMs - FACETS_RANGE_MS),
					endTime: formatWarehouseDateTime(nowMs),
				}),
				nowMs,
				mode,
			}),
		),
})

// STORAGE (`serviceMapLayoutAtomFamily`, `serviceMapViewPrefsAtomFamily`: `Atom.kvs` JSON per org)

const layoutKey = (orgId: string) => `maple.service-map.layout.${orgId}`
const prefsKey = (orgId: string) => `maple.service-map.view-prefs.${orgId}`

const LayoutJson = Schema.fromJsonString(Schema.Struct({ snapshots: Schema.Array(Snapshot) }))
const PrefsJson = Schema.fromJsonString(ViewPrefs)

/** Undecodable entries fall back to the defaults, as the atoms do. */
const readJson = <A>(key: string, schema: Schema.Decoder<A>): Option.Option<A> =>
	Option.flatMap(readLocalStorage(key), (raw) => Schema.decodeUnknownOption(schema)(raw))

export const ReadStored = Command.define("ReadServiceMapStored", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReadStored],
	execute: ({ orgId }) =>
		Effect.sync(() =>
			Message.CompletedReadStored({
				stored: {
					prefs: Option.getOrElse(readJson(prefsKey(orgId), PrefsJson), () => ({
						minTrafficPct: 0,
						collapsedNamespaces: [],
					})),
					snapshots: Option.match(readJson(layoutKey(orgId), LayoutJson), {
						onNone: () => [],
						onSome: (layout) => layout.snapshots,
					}),
				},
			}),
		),
})

export const SaveStored = Command.define("SaveServiceMapStored", {
	args: { orgId: Schema.String, stored: StoredSchema },
	messages: [Message.CompletedSaveStored],
	execute: ({ orgId, stored }) =>
		Effect.sync(() => {
			writeLocalStorage(prefsKey(orgId), Schema.encodeSync(PrefsJson)(stored.prefs))
			writeLocalStorage(
				layoutKey(orgId),
				Schema.encodeSync(LayoutJson)({ snapshots: stored.snapshots }),
			)
			return Message.CompletedSaveStored()
		}),
})

// FETCHES (each carries its request key back so `update` drops a superseded answer, S6)

/** `GetServiceMapInput`: the window, scoped to one environment unless "All environments". */
export const MapInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	deploymentEnv: Schema.optional(Schema.String),
})
export type MapInput = typeof MapInput.Type

export const FetchFacets = Command.define("FetchServiceMapFacets", {
	/** `refresh`: Reload and Try again revalidate past the read cache (`useAtomRefresh`). */
	args: { key: Schema.String, window: TimeWindow, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window, refresh }) =>
		loadServicesFacets(window, { key, refresh }).pipe(
			Effect.map(({ data }) => data.environments.map((environment) => environment.name)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const FetchBundle = Command.define("FetchServiceMapBundle", {
	args: { key: Schema.String, input: MapInput },
	messages: [Message.CompletedFetchBundle],
	execute: ({ key, input }) =>
		getServiceMapBundle({ data: input }).pipe(
			Effect.map((bundle) => new MapBundle(bundle)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchBundle({ key, result })),
		),
})

export const FetchCloudflare = Command.define("FetchServiceMapCloudflare", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchCloudflare],
	execute: ({ key, window }) =>
		getServiceMapCloudflare({ data: window }).pipe(
			Effect.map((stats) => new CloudflareStats(stats)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCloudflare({ key, result })),
		),
})

export const FetchPlanetScaleStats = Command.define("FetchServiceMapPlanetScale", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchPlanetScaleStats],
	execute: ({ key, window }) =>
		getServiceMapPlanetScale({ data: window }).pipe(
			Effect.map((stats) => new PlanetScaleStats(stats)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPlanetScaleStats({ key, result })),
		),
})

/** `retainedQueryV2("planetscaleIntegration", "databases")`, keyed like the map does. */
export const FetchPlanetScaleInventory = Command.define("FetchPlanetScaleInventory", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchPlanetScaleInventory],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.planetscaleIntegration.databases()
			return response.databases.map((db) => ({
				name: db.name,
				kind: db.kind,
				branchCount: db.branches.length,
				branches: db.branches.map((branch) => ({
					name: branch.name,
					production: branch.production,
					ready: branch.ready,
				})),
			}))
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPlanetScaleInventory({ key, result })),
		),
})

/** `retainedInternalQuery("integrations", "cloudflareHyperdrives")`. */
export const FetchHyperdrives = Command.define("FetchCloudflareHyperdrives", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchHyperdrives],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.cloudflareHyperdrives()
			return response.configs.map((config) => ({
				id: config.id,
				name: config.name,
				originHost: config.originHost,
				originPort: config.originPort,
				originScheme: config.originScheme,
				originDatabase: config.originDatabase,
				originUser: config.originUser,
			}))
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchHyperdrives({ key, result })),
		),
})

/** `getServiceDbQuerySummary`'s input as the database panel builds it. */
export const DbSummaryInput = Schema.Struct({
	dbSystem: Schema.String,
	dbNamespace: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	deploymentEnv: Schema.optional(Schema.String),
	bucketSeconds: Schema.Number,
	topN: Schema.Number,
})
export type DbSummaryInput = typeof DbSummaryInput.Type

export const FetchDbSummary = Command.define("FetchServiceDbQuerySummary", {
	args: { key: Schema.String, input: DbSummaryInput },
	messages: [Message.CompletedFetchDbSummary],
	execute: ({ key, input }) =>
		getServiceDbQuerySummary({ data: input }).pipe(
			Effect.map((summary) => new DbSummary(summary)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDbSummary({ key, result })),
		),
})

export const BranchStatsInput = Schema.Struct({
	database: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type BranchStatsInput = typeof BranchStatsInput.Type

export const FetchBranchStats = Command.define("FetchPlanetScaleBranchStats", {
	args: { key: Schema.String, input: BranchStatsInput },
	messages: [Message.CompletedFetchBranchStats],
	execute: ({ key, input }) =>
		getPlanetScaleBranchStats({ data: input }).pipe(
			Effect.map((stats) => new BranchStats(stats)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchBranchStats({ key, result })),
		),
})

export const LoadSignalPresence = Command.define("LoadServiceMapSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteServiceMapReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

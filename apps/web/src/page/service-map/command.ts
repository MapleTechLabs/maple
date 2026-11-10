import { reloadSpin } from "@maple/views/data/timing"
import { RequestMode } from "@maple/views/data/keyed"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import {
	getPlanetScaleBranchStats,
	getServiceDbQuerySummary,
	getServiceMapBundle,
	getServiceMapCloudflare,
	getServiceMapPlanetScale,
} from "@maple/web-data/warehouse/service-map"
import { Clock, Effect, Option, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import { loadServicesFacets } from "../../data/services-facets-probe"
import { settleTo } from "@maple/views/data/load-failure"
import { resolveWindow, TimeWindow } from "../../data/time-range"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Snapshot, ViewPrefs } from "@maple/views/service-map/map/state"
import { loadSignalPresences } from "../kit/signal-presence"
import { ApplyWorldOpsRequest, WorldOp } from "@maple/domain/http"
import { Applied, type BatchOutcome, Conflicted, Rejected } from "./factory/edits"
import { Message } from "./message"
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
	Option.flatMap(readLocalStorage(key), (raw) => Schema.decodeOption(schema)(raw))

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
		Effect.gen(function* () {
			const prefs = yield* Schema.encodeEffect(PrefsJson)(stored.prefs)
			const layout = yield* Schema.encodeEffect(LayoutJson)({ snapshots: stored.snapshots })
			writeLocalStorage(prefsKey(orgId), prefs)
			writeLocalStorage(layoutKey(orgId), layout)
		}).pipe(Effect.ignore, Effect.as(Message.CompletedSaveStored())),
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
			Effect.map(({ data }) => Arr.map(data.environments, (environment) => environment.name)),
			settleTo((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const FetchBundle = Command.define("FetchServiceMapBundle", {
	args: { key: Schema.String, input: MapInput },
	messages: [Message.CompletedFetchBundle],
	execute: ({ key, input }) =>
		getServiceMapBundle({ data: input }).pipe(
			Effect.map((bundle) => new MapBundle(bundle)),
			settleTo((result) => Message.CompletedFetchBundle({ key, result })),
		),
})

export const FetchCloudflare = Command.define("FetchServiceMapCloudflare", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchCloudflare],
	execute: ({ key, window }) =>
		getServiceMapCloudflare({ data: window }).pipe(
			Effect.map((stats) => new CloudflareStats(stats)),
			settleTo((result) => Message.CompletedFetchCloudflare({ key, result })),
		),
})

export const FetchPlanetScaleStats = Command.define("FetchServiceMapPlanetScale", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchPlanetScaleStats],
	execute: ({ key, window }) =>
		getServiceMapPlanetScale({ data: window }).pipe(
			Effect.map((stats) => new PlanetScaleStats(stats)),
			settleTo((result) => Message.CompletedFetchPlanetScaleStats({ key, result })),
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
			return Arr.map(response.databases, (db) => ({
				name: db.name,
				kind: db.kind,
				branchCount: db.branches.length,
				branches: Arr.map(db.branches, (branch) => ({
					name: branch.name,
					production: branch.production,
					ready: branch.ready,
				})),
			}))
		}).pipe(settleTo((result) => Message.CompletedFetchPlanetScaleInventory({ key, result }))),
})

/** `retainedInternalQuery("integrations", "cloudflareHyperdrives")`. */
export const FetchHyperdrives = Command.define("FetchCloudflareHyperdrives", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchHyperdrives],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.cloudflareHyperdrives()
			return Arr.map(response.configs, (config) => ({
				id: config.id,
				name: config.name,
				originHost: config.originHost,
				originPort: config.originPort,
				originScheme: config.originScheme,
				originDatabase: config.originDatabase,
				originUser: config.originUser,
			}))
		}).pipe(settleTo((result) => Message.CompletedFetchHyperdrives({ key, result }))),
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
			settleTo((result) => Message.CompletedFetchDbSummary({ key, result })),
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
			settleTo((result) => Message.CompletedFetchBranchStats({ key, result })),
		),
})

export const LoadSignalPresence = Command.define("LoadServiceMapSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

export const CompleteReloadSpin = reloadSpin("CompleteServiceMapReloadSpin", Message.CompletedReloadSpin)

/** The org's shared factory world, for the 3D viewport. */
export const LoadWorld = Command.define("LoadServiceMapWorld", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadWorld],
	execute: ({ orgId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.serviceMapWorld.get()).pipe(
			settleTo((result) => Message.CompletedLoadWorld({ orgId, result })),
		),
})

/** One batch of world edits. A revision conflict is an outcome, not a failure: the viewport
 * adopts the stored rows and keeps the rest of its edits. A batch the server (or the request's
 * own validation) refuses for good is `Rejected`, so it never blocks the saves after it. */
export const SaveWorld = Command.define("SaveServiceMapWorld", {
	args: { orgId: Schema.String, batch: Schema.Number, ops: Schema.Array(WorldOp) },
	messages: [Message.CompletedSaveWorld],
	execute: ({ orgId, batch, ops }) =>
		Schema.decodeEffect(ApplyWorldOpsRequest)({ ops }).pipe(
			Effect.matchEffect({
				onFailure: (error) => Effect.succeed<BatchOutcome>(Rejected.make({ message: error.message })),
				onSuccess: (payload) =>
					Effect.flatMap(MapleInternalApiClient, (client) =>
						client.serviceMapWorld.apply({ payload }),
					).pipe(
						Effect.map((response): BatchOutcome => Applied.make({ response })),
						Effect.catchTags({
							"@maple/http/service-map-world/WorldConflictError": (conflict) =>
								Effect.succeed<BatchOutcome>(Conflicted.make({ conflict })),
							"@maple/http/service-map-world/WorldInvalidOpsError": (error) =>
								Effect.succeed<BatchOutcome>(Rejected.make({ message: error.message })),
						}),
					),
			}),
			settleTo((result) => Message.CompletedSaveWorld({ orgId, batch, result })),
		),
})

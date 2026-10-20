import type {
	getPlanetScaleBranchStats,
	getServiceDbQuerySummary,
	getServiceMapBundle,
	getServiceMapCloudflare,
	getServiceMapPlanetScale,
} from "@maple/web-data/warehouse/service-map"
import { type Effect, Schema } from "effect"
import * as Chart from "../../charts/chart"
import { ChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { ServiceMapSearch } from "../../route/search"
import * as ServiceMap from "../../service-map/map/service-map"
import { Snapshot, ViewPrefs } from "../../service-map/map/state"
import * as Select from "../../ui/select"
import * as Tabs from "../../ui/tabs"
import { SignalPresenceData } from "../kit/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"
import * as Scene3d from "./scene3d"

// `/service-map`.

// The warehouse answers feed `buildFlowElements` unchanged, so they stay the web-data shapes,
// boxed as opaque values (as `SourceGraph` is) rather than re-declared as Schemas.

export class MapBundle {
	constructor(readonly value: Effect.Success<ReturnType<typeof getServiceMapBundle>>) {}
}
export class CloudflareStats {
	constructor(readonly value: Effect.Success<ReturnType<typeof getServiceMapCloudflare>>) {}
}
export class PlanetScaleStats {
	constructor(readonly value: Effect.Success<ReturnType<typeof getServiceMapPlanetScale>>) {}
}
export class DbSummary {
	constructor(readonly value: Effect.Success<ReturnType<typeof getServiceDbQuerySummary>>) {}
}
export class BranchStats {
	constructor(readonly value: Effect.Success<ReturnType<typeof getPlanetScaleBranchStats>>) {}
}

/** `planetscaleIntegration.databases`, as the map keys it (lowercased name → identity). */
export const PlanetScaleDatabase = Schema.Struct({
	name: Schema.String,
	kind: Schema.String,
	branchCount: Schema.Number,
	branches: Schema.Array(
		Schema.Struct({ name: Schema.String, production: Schema.Boolean, ready: Schema.Boolean }),
	),
})
export type PlanetScaleDatabase = typeof PlanetScaleDatabase.Type

/** `integrations.cloudflareHyperdrives`, as `HyperdriveConfigInput`. */
export const HyperdriveConfig = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	originHost: Schema.NullOr(Schema.String),
	originPort: Schema.NullOr(Schema.Number),
	originScheme: Schema.String,
	originDatabase: Schema.String,
	originUser: Schema.NullOr(Schema.String),
})
export type HyperdriveConfig = typeof HyperdriveConfig.Type

/** What the page keeps in localStorage per org: declutter prefs and the layout snapshots. */
export const Stored = Schema.Struct({ prefs: ViewPrefs, snapshots: Schema.Array(Snapshot) })
export type Stored = typeof Stored.Type

export const MapBundleSchema = Schema.instanceOf(MapBundle)
export const CloudflareStatsSchema = Schema.instanceOf(CloudflareStats)
export const PlanetScaleStatsSchema = Schema.instanceOf(PlanetScaleStats)
export const DbSummarySchema = Schema.instanceOf(DbSummary)
export const BranchStatsSchema = Schema.instanceOf(BranchStats)

export const Model = Schema.Struct({
	search: ServiceMapSearch,
	/** The map's window and the 24 h facets window, resolved at the same clock; `null` until resolved. */
	window: Schema.NullOr(TimeWindow),
	/** The zone `window` was resolved in: a zone change re-resolves it. */
	windowZone: Schema.NullOr(Schema.String),
	facetsWindow: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** Environment names from `getServicesFacets` over the fixed 24 h window. */
	facets: KeyedSchema(Schema.Array(Schema.String), LoadFailure),
	bundle: KeyedSchema(MapBundleSchema, LoadFailure),
	cloudflare: KeyedSchema(CloudflareStatsSchema, LoadFailure),
	planetscaleStats: KeyedSchema(PlanetScaleStatsSchema, LoadFailure),
	planetscaleInventory: KeyedSchema(Schema.Array(PlanetScaleDatabase), LoadFailure),
	hyperdrives: KeyedSchema(Schema.Array(HyperdriveConfig), LoadFailure),
	/** localStorage read on entry; the map is built once it and the bundle are in. */
	stored: Schema.Option(Stored),
	map: Schema.Option(ServiceMap.Model),
	/** The selected database node's query summary and PlanetScale branches. */
	dbSummary: KeyedSchema(DbSummarySchema, LoadFailure),
	branchStats: KeyedSchema(BranchStatsSchema, LoadFailure),
	/** The service panel's Service / Infrastructure tabs (`defaultValue="service"`, reset per node). */
	serviceTabs: Tabs.Model,
	/** The database panel's query volume and latency plots. */
	dbCharts: Schema.Struct({ volume: Chart.Model, latency: Chart.Model }),
	environmentSelect: Select.Model,
	timePicker: TimeRangePicker.Model,
	/** The 3D view's own state; fresh each time the view switches to 3D. */
	scene3d: Scene3d.Model,
	/** `useSignalPresence("traces")` of the empty canvas, requested once it painted. */
	presence: SignalPresenceData.schema,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

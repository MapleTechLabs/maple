import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { ThemeColors } from "../../charts/theme-colors"
import { LoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import * as ServiceMap from "../../service-map/map/service-map"
import * as Select from "../../ui/select"
import * as Tabs from "../../ui/tabs"
import { SignalPresences } from "../kit/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"
import * as Scene3d from "./scene3d"
import {
	BranchStatsSchema,
	CloudflareStatsSchema,
	DbSummarySchema,
	HyperdriveConfig,
	MapBundleSchema,
	PlanetScaleDatabase,
	PlanetScaleStatsSchema,
	Stored,
} from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: {
		window: TimeWindow,
		timeZone: Schema.String,
		facetsWindow: TimeWindow,
		nowMs: Schema.Number,
		mode: RequestMode,
	},
	CompletedReadStored: { stored: Stored },
	CompletedSaveStored: {},
	CompletedFetchFacets: result(Schema.Array(Schema.String)),
	CompletedFetchBundle: result(MapBundleSchema),
	CompletedFetchCloudflare: result(CloudflareStatsSchema),
	CompletedFetchPlanetScaleStats: result(PlanetScaleStatsSchema),
	CompletedFetchPlanetScaleInventory: result(Schema.Array(PlanetScaleDatabase)),
	CompletedFetchHyperdrives: result(Schema.Array(HyperdriveConfig)),
	CompletedFetchDbSummary: result(DbSummarySchema),
	CompletedFetchBranchStats: result(BranchStatsSchema),
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetryFacets: {},
	ClickedResetTimeRange: {},
	ClickedView: { view: Schema.Literals(["2d", "3d"]) },
	GotMapMessage: { message: ServiceMap.Message },
	GotEnvironmentSelectMessage: { message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotScene3dMessage: { message: Scene3d.Message },
	GotServiceTabsMessage: { message: Tabs.Message },
	GotChartMessage: { chart: Schema.Literals(["volume", "latency"]), message: Chart.Message },
})
export type Message = typeof Message.Type

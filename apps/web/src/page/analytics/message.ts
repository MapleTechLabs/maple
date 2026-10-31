import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { ThemeColors } from "../../charts/theme-colors"
import { LoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import * as Dialog from "../../ui/dialog"
import * as FilterSections from "../../ui/filters/filter-sections"
import { SignalPresences } from "../kit/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** Every Keyed slot of the page, by its Model field. */
export const SlotName = Schema.Literals([
	"breakdowns",
	"events",
	"live",
	"summary",
	"mix",
	"timeseries",
	"pageviews",
	"pages",
	"previousSummary",
	"previousPageviews",
	"aiReferrals",
	"previousAiReferrals",
	"aiCrawlers",
	"traceSamples",
])
export type SlotName = typeof SlotName.Type

/** An `AnalyticsFilterKey`. */
export const FilterKey = Schema.Literals([
	"host",
	"pagePath",
	"referrerHost",
	"country",
	"deviceType",
	"browserName",
	"osName",
	"language",
	"utmSource",
	"utmMedium",
	"utmCampaign",
	"visitorType",
	"traffic",
	"eventName",
])
export type FilterKey = typeof FilterKey.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	/** Any slot's answer; `key` is what it was requested under, so a stale one is dropped. */
	CompletedFetch: {
		slot: SlotName,
		key: Schema.String,
		result: Schema.Result(Schema.Unknown, LoadFailure),
	},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	TickedLivePoll: {},
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedRetrySummary: {},
	ClickedRetryBreakdowns: {},
	/** The one page block shown when summary and breakdowns fail the same way: retries both. */
	ClickedRetrySummaryAndBreakdowns: {},
	/** A sidebar option or a breakdown row: the value toggles in or out of the URL. */
	ToggledFilter: { key: FilterKey, value: Schema.String },
	/** A sidebar section picked a single value (or cleared it). */
	ChangedFilter: { key: FilterKey, value: Schema.UndefinedOr(Schema.String) },
	ToggledTraffic: { which: Schema.Literals(["humans", "bots"]), isOn: Schema.Boolean },
	ClickedClearFilters: {},
	PickedMetric: { metric: Schema.String },
	PickedPanelTab: { panel: Schema.String, index: Schema.Number },
	ChangedPanelQuery: { panel: Schema.String, value: Schema.String },
	/** `current` is the column sorted now, the panel's default until someone clicks. */
	ClickedPanelSort: {
		panel: Schema.String,
		key: Schema.Literals(["name", "count", "views"]),
		current: Schema.Struct({
			key: Schema.Literals(["name", "count", "views"]),
			dir: Schema.Literals(["asc", "desc"]),
		}),
	},
	ClickedExpandPanel: { panel: Schema.String },
	ClickedExpandedRow: { key: FilterKey, value: Schema.String },
	FailedFavicon: { host: Schema.String },
	GotExpandDialogMessage: { message: Dialog.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { message: Chart.Message },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
})
export type Message = typeof Message.Type

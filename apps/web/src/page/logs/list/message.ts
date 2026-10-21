import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as LogsStream from "../../../ui/logs/logs-stream"
import * as Menu from "../../../ui/menu"
import * as Popover from "../../../ui/popover"
import * as Tooltip from "../../../ui/tooltip"
import * as LogDetail from "../detail"
import { SignalPresences } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { AttributeKey, Density, LogsFacets, LogsPage, VolumeBucket } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The sidebar's facets, by their include param. */
export const Facet = Schema.Literals(["severities", "deploymentEnvs", "namespaces", "services"])
export type Facet = typeof Facet.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchFirstPage: result(LogsPage),
	CompletedFetchNextPage: { generation: Schema.Number, ...result(LogsPage) },
	CompletedFetchFacets: result(LogsFacets),
	CompletedFetchVolume: result(Schema.Array(VolumeBucket)),
	CompletedFetchAttributeKeys: result(Schema.Array(AttributeKey)),
	CompletedReadPreferences: { wrap: Schema.Boolean, density: Density, locale: Schema.String },
	CompletedSavePreference: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	/** `LogsFilterSidebar` mounted (inline, or in the sheet below `lg`): its facets read goes out. */
	MountedFilterRail: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	TickedAutoRefresh: {},
	ClickedJumpToLatest: {},
	ClickedRetryFacets: {},
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	ClickedClearAllFilters: {},
	RemovedFilterChip: { chipId: Schema.String },
	ClickedClearFilterChips: {},
	ClickedClearExclusions: {},
	ChangedSearchText: { text: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	ClickedWrap: {},
	ClickedDensity: {},
	ClickedResetTimeRange: {},
	ClickedClearNamespacePin: {},
	ClickedClearSearch: {},
	ClickedWidenRange: {},
	GotStreamMessage: { message: LogsStream.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotRefreshMenuMessage: { message: Menu.Message },
	GotToolbarTooltipMessage: { message: Tooltip.Message },
	GotColumnsPopoverMessage: { message: Popover.Message },
	GotSearchHelpMessage: { message: Popover.Message },
	GotDetailMessage: { message: LogDetail.Message },
	ToggledColumn: { key: Schema.String },
	GotVolumeChartMessage: { message: Chart.Message },
	PressedVolumeChart: {},
	ReleasedVolumeChart: {},
	LeftVolumeChart: {},
})
export type Message = typeof Message.Type

import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraCloudflareZoneSearch } from "../../../../route/search"
import * as CopyButton from "../../../../ui/copy-button"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Popover from "../../../../ui/popover"
import * as Tooltip from "../../../../ui/tooltip"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"
import {
	BreakdownDimension,
	Status,
	TopTraffic,
	Usage,
	ZoneBreakdown,
	ZoneDetail,
	ZoneDns,
	ZoneFacets,
	ZoneRow,
	ZoneSecurity,
} from "../data"

// `/infra/cloudflare/$zoneName`.

export const ZoneTab = Schema.Literals(["traffic", "dns", "security"])
export type ZoneTab = typeof ZoneTab.Type

export const FilterKey = Schema.Literals([
	"hosts",
	"cacheStatuses",
	"statusClasses",
	"paths",
	"pathContains",
	"countries",
	"methods",
	"protocols",
	"deviceTypes",
])
export type FilterKey = typeof FilterKey.Type

export const BreakdownSortKey = Schema.Literals(["key", "requests", "errorRate", "bytes"])
export type BreakdownSortKey = typeof BreakdownSortKey.Type

export const Model = Schema.Struct({
	zoneName: Schema.String,
	search: InfraCloudflareZoneSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(Status, LoadFailure),
	usage: KeyedSchema(Usage, LoadFailure),
	detail: KeyedSchema(ZoneDetail, LoadFailure),
	dns: KeyedSchema(ZoneDns, LoadFailure),
	security: KeyedSchema(ZoneSecurity, LoadFailure),
	facets: KeyedSchema(ZoneFacets, LoadFailure),
	/** The list rollup's rows, for this zone's bytes, visits and latency. */
	zones: KeyedSchema(Schema.Array(ZoneRow), LoadFailure),
	/** `CloudflareBreakdownPanel`'s own state: the dimension, the toolbar filter, the live lookup. */
	dimension: BreakdownDimension,
	breakdown: KeyedSchema(ZoneBreakdown, LoadFailure),
	breakdownSearch: Schema.String,
	breakdownSort: sortStateOf(BreakdownSortKey),
	liveQuery: Schema.NullOr(Schema.String),
	liveTraffic: KeyedSchema(TopTraffic, LoadFailure),
	liveSort: sortStateOf(BreakdownSortKey),
	areChipsExpanded: Schema.Boolean,
	filterPopover: Popover.Model,
	filterSections: FilterSections.Model,
	tooltip: Tooltip.Model,
	copyService: CopyButton.Model,
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: result(Status),
	CompletedLoadUsage: result(Usage),
	CompletedFetchDetail: result(ZoneDetail),
	CompletedFetchDns: result(ZoneDns),
	CompletedFetchSecurity: result(ZoneSecurity),
	CompletedFetchFacets: result(ZoneFacets),
	CompletedFetchZones: result(Schema.Array(ZoneRow)),
	CompletedFetchBreakdown: result(ZoneBreakdown),
	CompletedFetchLiveTraffic: result(TopTraffic),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	AttachedLinkedCursor: {},
	/** The poll reads the clock so the phase can advance to "stalled". */
	TickedIngestPoll: { nowMs: Schema.Number },
	ClickedTab: { tab: ZoneTab },
	ToggledFilter: { key: FilterKey, value: Schema.String },
	RemovedFilterChip: { key: FilterKey, value: Schema.String },
	ClickedClearFilters: {},
	ClickedExpandChips: {},
	ClickedDimension: { dimension: BreakdownDimension },
	ChangedBreakdownSearch: { value: Schema.String },
	ClickedSearchLive: {},
	ClickedLeaveLive: {},
	ClickedBreakdownSort: { key: BreakdownSortKey },
	ClickedLiveSort: { key: BreakdownSortKey },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotFilterPopoverMessage: { message: Popover.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTooltipMessage: { message: Tooltip.Message },
	GotCopyServiceMessage: { message: CopyButton.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

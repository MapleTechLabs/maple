import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraPlanetscaleDatabaseSearch } from "../../../../route/search"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Select from "../../../../ui/select"
import * as Tooltip from "../../../../ui/tooltip"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"
import {
	BranchStat,
	DatabaseList,
	EventEntry,
	PlanetscaleStatus,
	QueryInsights,
	TimeseriesRow,
} from "../data"

// `/infra/planetscale/$dbName`.

export const Measure = Schema.Literals(["connections", "cpu", "memory", "storage", "lag"])
export type Measure = typeof Measure.Type

export const BreakdownSortKey = Schema.Literals(["branch", "value"])
export type BreakdownSortKey = typeof BreakdownSortKey.Type

export const FilterKey = Schema.Literals(["branches", "branchStates", "branchRoles", "branchContains"])

export const LocalWindow = Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number })
export type LocalWindow = typeof LocalWindow.Type

export const Model = Schema.Struct({
	dbName: Schema.String,
	search: InfraPlanetscaleDatabaseSearch,
	window: Schema.NullOr(TimeWindow),
	/** `window` read as browser-local time, for the events read. */
	localWindow: Schema.NullOr(LocalWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(PlanetscaleStatus, LoadFailure),
	databases: KeyedSchema(DatabaseList, LoadFailure),
	branchStats: KeyedSchema(Schema.Array(BranchStat), LoadFailure),
	timeseries: KeyedSchema(Schema.Array(TimeseriesRow), LoadFailure),
	events: KeyedSchema(Schema.Array(EventEntry), LoadFailure),
	insights: KeyedSchema(QueryInsights, LoadFailure),
	measure: Measure,
	breakdownSort: sortStateOf(BreakdownSortKey),
	charts: Schema.Record(Schema.String, Chart.Model),
	branchSelect: Select.Model,
	filterSections: FilterSections.Model,
	tooltip: Tooltip.Model,
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
	CompletedResolveWindow: {
		window: TimeWindow,
		localWindow: LocalWindow,
		nowMs: Schema.Number,
		mode: RequestMode,
	},
	CompletedLoadStatus: result(PlanetscaleStatus),
	CompletedFetchDatabases: result(DatabaseList),
	CompletedFetchBranchStats: result(Schema.Array(BranchStat)),
	CompletedFetchTimeseries: result(Schema.Array(TimeseriesRow)),
	CompletedFetchEvents: result(Schema.Array(EventEntry)),
	CompletedFetchInsights: result(QueryInsights),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedRetryTimeseries: {},
	ClickedRetryBranchStats: {},
	ClickedMeasure: { measure: Measure },
	ClickedBreakdownSort: { key: BreakdownSortKey },
	ToggledBranch: { branch: Schema.String },
	SelectedBranch: { branch: Schema.optional(Schema.String) },
	ToggledFilterOption: { key: FilterKey, name: Schema.String },
	RemovedFilterChip: { key: FilterKey, value: Schema.String },
	ClickedClearFilters: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	GotBranchSelectMessage: { message: Select.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTooltipMessage: { message: Tooltip.Message },
})
export type Message = typeof Message.Type

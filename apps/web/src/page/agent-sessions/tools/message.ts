import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Select from "../../../ui/select"
import * as ToggleGroup from "../../../ui/toggle-group"
import { SignalPresences } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Facets } from "../list/model"
import { ToolMetric, ToolSeries, TotalsResult } from "../tools-kit/model"
import { Breakdowns } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const FacetKey = Schema.Literals(["service", "model", "env"])
export type FacetKey = typeof FacetKey.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchSeries: result(ToolSeries),
	CompletedFetchScopeSeries: result(ToolSeries),
	CompletedFetchTotals: result(TotalsResult),
	CompletedFetchBreakdowns: result(Breakdowns),
	CompletedFetchFacets: result(Facets),
	CompletedFetchTabTotals: result(TotalsResult),
	CompletedFetchTabBreakdowns: result(Breakdowns),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ChangedSearchInput: { value: Schema.String },
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledFailingOnly: {},
	ClickedMetric: { metric: ToolMetric },
	RemovedScopeChip: { kind: Schema.Literals(["tool", "model"]) },
	ClickedClearScope: {},
	ClickedTableSort: { key: Schema.String },
	GotFacetSelectMessage: { facet: FacetKey, message: Select.Message },
	GotPercentileMessage: { message: ToggleGroup.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	GotChartMessage: { message: Chart.Message },
	/** The table sparks: no focus or tooltip to keep. */
	GotSparkMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

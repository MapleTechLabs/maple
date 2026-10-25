import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Select from "../../../ui/select"
import { SignalPresences } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Catalog, SparklineSeries, SummaryRow } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const BrowseView = Schema.Literals(["grid", "table"])
export type BrowseView = typeof BrowseView.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchCatalog: result(Catalog),
	CompletedFetchTable: result(Catalog),
	CompletedFetchSummary: result(Schema.Array(SummaryRow)),
	CompletedFetchSparklines: { slot: Schema.String, ...result(SparklineSeries) },
	ChangedSearchInput: { value: Schema.String },
	CompletedSearchDebounce: { generation: Schema.Number },
	ClickedClearSearch: {},
	ClickedView: { view: BrowseView },
	ClickedLoadMorePages: {},
	ClickedLoadMoreTable: {},
	ClickedMetricCard: { metricName: Schema.String, metricType: Schema.String },
	ClickedClearFilters: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	GotTypeSelectMessage: { message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotSparklineMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

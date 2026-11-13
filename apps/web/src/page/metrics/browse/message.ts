import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { RequestMode } from "@maple/views/data/keyed"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Select from "@maple/views/ui/select"
import { SignalPresences } from "@maple/views/data/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Catalog, SparklineSeries, SummaryRow } from "./model"

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
	/** A list key over the table: J / K / arrows, Enter, Escape. */
	PressedListKey: { key: Schema.String },
	CompletedScrollFocusedRow: {},
	ClickedClearFilters: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	...ChartEnvMessages,
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	GotTypeSelectMessage: { message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotSparklineMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

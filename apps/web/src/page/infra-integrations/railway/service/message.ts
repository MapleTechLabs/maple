import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { TracedService } from "../../kit/traced"
import { RailwayServiceRow, RailwayServiceTimeseriesRow } from "../model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchServices: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(RailwayServiceRow), LoadFailure),
	},
	CompletedFetchTimeseries: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(RailwayServiceTimeseriesRow), LoadFailure),
	},
	CompletedFetchTraced: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(TracedService), LoadFailure),
	},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedRetryTimeseries: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

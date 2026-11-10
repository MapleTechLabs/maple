import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { RequestMode } from "@maple/views/data/keyed"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { TracedService } from "../../kit/traced"
import { BucketPoint } from "../data"

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchTimeseries: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(BucketPoint), LoadFailure),
	},
	CompletedFetchTraced: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(TracedService), LoadFailure),
	},
	...ChartEnvMessages,
	ClickedRetry: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

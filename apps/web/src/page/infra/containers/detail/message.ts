import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../../kit/series"
import { ContainerMetric, ContainerSummary } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(ContainerSummary, LoadFailure) },
	CompletedFetchSeries: { metric: ContainerMetric, key: Schema.String, result: SeriesResult },
	ClickedMetric: { metric: ContainerMetric },
	ClickedRetrySummary: {},
	ClickedWidenRange: {},
	...ChartEnvMessages,
	GotChartMessage: { metric: ContainerMetric, message: Chart.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

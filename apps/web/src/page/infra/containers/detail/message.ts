import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../kit/series"
import { ContainerMetric, ContainerSummary } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(ContainerSummary, LoadFailure) },
	CompletedFetchSeries: { metric: ContainerMetric, key: Schema.String, result: SeriesResult },
	ClickedMetric: { metric: ContainerMetric },
	ClickedRetrySummary: {},
	ClickedWidenRange: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { metric: ContainerMetric, message: Chart.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

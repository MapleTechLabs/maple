import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import * as CopyButton from "../../../../ui/copy-button"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../kit/series"
import { HostSummary } from "./model"

export const HostMetric = Schema.Literals(["cpu", "memory", "filesystem", "network", "load15"])
export type HostMetric = typeof HostMetric.Type

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(HostSummary, LoadFailure) },
	CompletedFetchSeries: { metric: HostMetric, key: Schema.String, result: SeriesResult },
	ClickedRetrySummary: {},
	ClickedWidenRange: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedMountLinkedCursor: {},
	GotChartMessage: { metric: HostMetric, message: Chart.Message },
	GotCopyMessage: { label: Schema.String, message: CopyButton.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

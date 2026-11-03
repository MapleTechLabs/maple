import { CodeReviewAnalytics } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Select from "@maple/views/ui/select"
import { FrameMessage } from "../kit/frame"

export const Message = defineMessageUnion({
	GotFrameMessage: { message: FrameMessage },
	CompletedFetchAnalytics: { key: Schema.String, result: Schema.Result(CodeReviewAnalytics, LoadFailure) },
	ClickedRetry: {},
	ClickedClearFilters: {},
	GotVolumeSelectMessage: { message: Select.Message },
	GotSeveritySelectMessage: { message: Select.Message },
	GotChartMessage: { chart: Schema.Literals(["volume", "issues"]), message: Chart.Message },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
})
export type Message = typeof Message.Type

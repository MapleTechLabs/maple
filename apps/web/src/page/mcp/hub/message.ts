import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Select from "../../../ui/select"
import * as ToggleGroup from "../../../ui/toggle-group"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { McpMetric } from "../view-server"
import { OverviewData, ServersData, SessionData, SessionsData, ToolData } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const Facet = Schema.Literals(["client", "kind"])
export type Facet = typeof Facet.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchServers: result(ServersData),
	CompletedFetchOverview: result(OverviewData),
	CompletedFetchTool: result(ToolData),
	CompletedFetchSessions: result(SessionsData),
	CompletedFetchSession: result(SessionData),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedWiden: {},
	ClickedOpenServer: { service: Schema.String },
	ClickedOpenTool: { tool: Schema.String },
	ClickedOpenTrace: { traceId: Schema.String },
	ClickedOpenSession: { sessionId: Schema.String },
	ClickedOpenAgentSession: { sessionId: Schema.String },
	ClickedInstrument: {},
	ClickedMetric: { metric: McpMetric },
	ChangedSearchInput: { value: Schema.String },
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledFailingOnly: {},
	GotSelectMessage: { facet: Facet, message: Select.Message },
	GotPercentileMessage: { message: ToggleGroup.Message },
	GotClientToggleMessage: { message: ToggleGroup.Message },
	GotCallsToggleMessage: { message: ToggleGroup.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	Ignored: {},
})
export type Message = typeof Message.Type

import {
	McpOverviewResponse,
	McpServersResponse,
	McpSessionResponse,
	McpSessionsResponse,
	McpToolResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { McpServersSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as ToggleGroup from "../../../ui/toggle-group"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { PresetValue } from "../../kit/time-controls"

// `/mcp-servers`, a server, its tool pages, its sessions and one session: one page, five views.

export const DEFAULT_MCP_PRESET: PresetValue = "24h"

export const McpView = Schema.TaggedUnion({
	Servers: {},
	Server: { service: Schema.String },
	Tool: { service: Schema.String, tool: Schema.String },
	Sessions: { service: Schema.String },
	Session: { service: Schema.String, sessionId: Schema.String },
})
export type McpView = typeof McpView.Type

export const ServersData = Schema.Struct(McpServersResponse.fields)
export const OverviewData = Schema.Struct(McpOverviewResponse.fields)
export const ToolData = Schema.Struct(McpToolResponse.fields)
export const SessionsData = Schema.Struct(McpSessionsResponse.fields)
export const SessionData = Schema.Struct(McpSessionResponse.fields)

export const Model = Schema.Struct({
	view: McpView,
	search: McpServersSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	servers: KeyedSchema(ServersData, LoadFailure),
	overview: KeyedSchema(OverviewData, LoadFailure),
	tool: KeyedSchema(ToolData, LoadFailure),
	sessions: KeyedSchema(SessionsData, LoadFailure),
	session: KeyedSchema(SessionData, LoadFailure),
	percentileToggle: ToggleGroup.Model,
	clientToggle: ToggleGroup.Model,
	callsToggle: ToggleGroup.Model,
	clientSelect: Select.Model,
	kindSelect: Select.Model,
	searchInput: Schema.String,
	searchVersion: Schema.Number,
	timePicker: TimeRangePicker.Model,
	charts: Schema.Record(Schema.String, Chart.Model),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

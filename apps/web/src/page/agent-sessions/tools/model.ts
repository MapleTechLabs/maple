import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AgentSessionToolsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as ToggleGroup from "../../../ui/toggle-group"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Facets } from "../list/model"
import { ToolBreakdownRow, ToolSeries, TotalsResult } from "../tools-kit/model"

// `/agent-sessions/tools`.

export const Breakdowns = Schema.Struct({ tools: Schema.Array(ToolBreakdownRow) })
export type Breakdowns = typeof Breakdowns.Type

export const Model = Schema.Struct({
	search: AgentSessionToolsSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	series: KeyedSchema(ToolSeries, LoadFailure),
	scopeSeries: KeyedSchema(ToolSeries, LoadFailure),
	totals: KeyedSchema(TotalsResult, LoadFailure),
	breakdowns: KeyedSchema(Breakdowns, LoadFailure),
	facets: KeyedSchema(Facets, LoadFailure),
	/** The tab counts over the bare window; only read when the page's own selection is filtered. */
	tabTotals: KeyedSchema(TotalsResult, LoadFailure),
	tabBreakdowns: KeyedSchema(Breakdowns, LoadFailure),
	serviceSelect: Select.Model,
	modelSelect: Select.Model,
	envSelect: Select.Model,
	percentileToggle: ToggleGroup.Model,
	timePicker: TimeRangePicker.Model,
	/** The Tools table's client-side sort (`useTableSort`, calls descending). */
	tableSort: Schema.Struct({ key: Schema.NullOr(Schema.String), dir: Schema.Literals(["asc", "desc"]) }),
	searchInput: Schema.String,
	searchVersion: Schema.Number,
	lastSentQuery: Schema.String,
	/** The scope chart's focus and tooltip. */
	chart: Chart.Model,
	presence: SignalPresenceData.schema,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

import { AiSessionListItem } from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AgentSessionToolSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Facets } from "../list/model"
import { ToolErrorRow, ToolSeries, TotalsResult } from "../tools-kit/model"
import * as ErrorModal from "./error-modal-model"

// `/agent-sessions/tools/$toolName`.

export const SessionRows = Schema.Struct({ data: Schema.Array(AiSessionListItem) })

const Sort = Schema.Struct({ key: Schema.NullOr(Schema.String), dir: Schema.Literals(["asc", "desc"]) })

export const Model = Schema.Struct({
	toolName: Schema.String,
	search: AgentSessionToolSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	series: KeyedSchema(ToolSeries, LoadFailure),
	totals: KeyedSchema(TotalsResult, LoadFailure),
	errors: KeyedSchema(Schema.Struct({ data: Schema.Array(ToolErrorRow) }), LoadFailure),
	sessions: KeyedSchema(SessionRows, LoadFailure),
	facets: KeyedSchema(Facets, LoadFailure),
	serviceSelect: Select.Model,
	modelSelect: Select.Model,
	envSelect: Select.Model,
	timePicker: TimeRangePicker.Model,
	/** The Errors table's client-side sort and its "Show N more" fold. */
	errorsSort: Sort,
	isErrorsExpanded: Schema.Boolean,
	/** Each grid chart's focus and tooltip, by chart id. */
	charts: Schema.Record(Schema.String, Chart.Model),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** `ToolErrorModal`, open while `?error=` names a row the Errors table holds. */
	errorModal: ErrorModal.Model,
})
export type Model = typeof Model.Type

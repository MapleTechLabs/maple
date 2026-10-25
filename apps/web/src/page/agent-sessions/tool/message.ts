import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Facets } from "../list/model"
import { ToolErrorRow, ToolSeries, TotalsResult } from "../tools-kit/model"
import * as ErrorModal from "./error-modal-model"
import { SessionRows } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const FacetKey = Schema.Literals(["service", "model", "env"])
export type FacetKey = typeof FacetKey.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchSeries: result(ToolSeries),
	CompletedFetchTotals: result(TotalsResult),
	CompletedFetchErrors: result(Schema.Struct({ data: Schema.Array(ToolErrorRow) })),
	CompletedFetchSessions: result(SessionRows),
	CompletedFetchFacets: result(Facets),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ToggledFailingOnly: {},
	RemovedModelChip: {},
	ClickedErrorRow: { fingerprint: Schema.String },
	ClickedErrorsSort: { key: Schema.String },
	ToggledErrorsExpanded: {},
	GotFacetSelectMessage: { facet: FacetKey, message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	GotErrorModalMessage: { message: ErrorModal.Message },
})
export type Message = typeof Message.Type

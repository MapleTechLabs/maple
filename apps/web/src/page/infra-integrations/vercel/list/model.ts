import {
	VercelAiGatewayResponse,
	VercelInfraProject,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraVercelSearch, VercelView } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"

// `/infra/vercel`.

export const SortKey = Schema.Literals(["name", "requests", "sortError", "sortCache", "sortP95", "errorLogs"])
export type SortKey = typeof SortKey.Type

export const Model = Schema.Struct({
	search: InfraVercelSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(VercelIntegrationStatus, LoadFailure),
	projects: KeyedSchema(Schema.Array(VercelInfraProject), LoadFailure),
	/** The fleet's request series, for the band's sparks. */
	buckets: KeyedSchema(Schema.Array(VercelInfraRequestBucket), LoadFailure),
	aiGateway: KeyedSchema(VercelAiGatewayResponse, LoadFailure),
	sort: sortStateOf(SortKey),
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: result(VercelIntegrationStatus),
	CompletedFetchProjects: result(Schema.Array(VercelInfraProject)),
	CompletedFetchBuckets: result(Schema.Array(VercelInfraRequestBucket)),
	CompletedFetchAiGateway: result(VercelAiGatewayResponse),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	/** `useIntervalRefresh` while a view is empty: the drains' first deliveries fill in on their own. */
	TickedEmptyRefresh: { slot: Schema.Literals(["projects", "aiGateway"]) },
	ClickedRetryStatus: {},
	ClickedRetryProjects: {},
	ClickedRetryBuckets: {},
	ClickedRetryAiGateway: {},
	ClickedView: { view: VercelView },
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ClickedSort: { key: SortKey },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

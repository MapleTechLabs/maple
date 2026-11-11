import {
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
	VercelInfraBreakdownRow,
	VercelInfraDependency,
	VercelInfraFunction,
	VercelInfraFunctionBucket,
	VercelInfraLatencyBucket,
	VercelInfraProject,
	VercelInfraProjectDetailResponse,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
	VercelSpeedInsightsResponse,
	VercelWebAnalyticsResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime } from "@maple/views/charts/chart-runtime"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraVercelProjectSearch, VercelBreakdownBy } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"

// `/infra/vercel/$projectId`: one tab at a time (`tab`), each reading only what it shows, beside the
// rail every tab shares.

export const Model = Schema.Struct({
	projectId: Schema.String,
	search: InfraVercelProjectSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The inventory: the project's name, framework and production deployment. */
	status: KeyedSchema(VercelIntegrationStatus, LoadFailure),
	/** The list's own read: this project's row comes from it. */
	projects: KeyedSchema(Schema.Array(VercelInfraProject), LoadFailure),
	buckets: KeyedSchema(Schema.Array(VercelInfraRequestBucket), LoadFailure),
	latency: KeyedSchema(Schema.Array(VercelInfraLatencyBucket), LoadFailure),
	/** The traffic tab's breakdown, by `search.by` and narrowed by `search.status`. */
	breakdown: KeyedSchema(Schema.Array(VercelInfraBreakdownRow), LoadFailure),
	detail: KeyedSchema(VercelInfraProjectDetailResponse, LoadFailure),
	deployments: KeyedSchema(Schema.Array(VercelDeploymentSummary), LoadFailure),
	aiGateway: KeyedSchema(VercelAiGatewayResponse, LoadFailure),
	functions: KeyedSchema(Schema.Array(VercelInfraFunction), LoadFailure),
	/** The functions tab's charts, for every route or `search.route`. */
	functionSeries: KeyedSchema(Schema.Array(VercelInfraFunctionBucket), LoadFailure),
	dependencies: KeyedSchema(Schema.Array(VercelInfraDependency), LoadFailure),
	speedInsights: KeyedSchema(VercelSpeedInsightsResponse, LoadFailure),
	webAnalytics: KeyedSchema(VercelWebAnalyticsResponse, LoadFailure),
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
	CompletedFetchLatency: result(Schema.Array(VercelInfraLatencyBucket)),
	CompletedFetchBreakdown: result(Schema.Array(VercelInfraBreakdownRow)),
	CompletedFetchDetail: result(VercelInfraProjectDetailResponse),
	CompletedFetchDeployments: result(Schema.Array(VercelDeploymentSummary)),
	CompletedFetchAiGateway: result(VercelAiGatewayResponse),
	CompletedFetchFunctions: result(Schema.Array(VercelInfraFunction)),
	CompletedFetchFunctionSeries: result(Schema.Array(VercelInfraFunctionBucket)),
	CompletedFetchDependencies: result(Schema.Array(VercelInfraDependency)),
	CompletedFetchSpeedInsights: result(VercelSpeedInsightsResponse),
	CompletedFetchWebAnalytics: result(VercelWebAnalyticsResponse),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedRetryRequests: {},
	ClickedRetryDetail: {},
	ClickedRetryBreakdown: {},
	ClickedBreakdownBy: { by: VercelBreakdownBy },
	ClickedBreakdownStatus: { status: Schema.NullOr(Schema.Literals(["4xx", "5xx"])) },
	AttachedLinkedCursor: {},
	ClickedRetryDeployments: {},
	ClickedRetryAiGateway: {},
	ClickedRetryFunctions: {},
	ClickedRetryFunctionSeries: {},
	/** A route's row: narrows the charts to it, or back to every route when it is already picked. */
	ClickedFunctionRoute: { route: Schema.NullOr(Schema.String) },
	/** A dependency's row: narrows the charts to invocations that called it, or back. */
	ClickedDependencyHost: { host: Schema.NullOr(Schema.String) },
	/** A breakdown row: narrows the traffic tab to its value, or back when it is already picked. */
	ClickedBreakdownRow: { value: Schema.NullOr(Schema.String) },
	ClickedRetryDependencies: {},
	ClickedRetrySpeedInsights: {},
	ClickedRetryWebAnalytics: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

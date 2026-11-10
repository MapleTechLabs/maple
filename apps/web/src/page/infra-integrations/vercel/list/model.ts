import {
	VercelAiGatewayResponse,
	VercelAuditEvent,
	VercelDeploymentSummary,
	VercelInfraLatencyBucket,
	VercelInfraProject,
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
import { InfraVercelSearch, VercelProjectScope } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"

// `/infra/vercel`: the team overview.

export const Model = Schema.Struct({
	search: InfraVercelSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(VercelIntegrationStatus, LoadFailure),
	projects: KeyedSchema(Schema.Array(VercelInfraProject), LoadFailure),
	/** The team's request series, from the logs drain. */
	buckets: KeyedSchema(Schema.Array(VercelInfraRequestBucket), LoadFailure),
	/** The team's function latency series, from the traces drain. */
	latency: KeyedSchema(Schema.Array(VercelInfraLatencyBucket), LoadFailure),
	aiGateway: KeyedSchema(VercelAiGatewayResponse, LoadFailure),
	/** The team's newest deployments, from Vercel's API. */
	deployments: KeyedSchema(Schema.Array(VercelDeploymentSummary), LoadFailure),
	speedInsights: KeyedSchema(VercelSpeedInsightsResponse, LoadFailure),
	webAnalytics: KeyedSchema(VercelWebAnalyticsResponse, LoadFailure),
	auditLog: KeyedSchema(Schema.Array(VercelAuditEvent), LoadFailure),
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
	CompletedFetchAiGateway: result(VercelAiGatewayResponse),
	CompletedFetchDeployments: result(Schema.Array(VercelDeploymentSummary)),
	CompletedFetchSpeedInsights: result(VercelSpeedInsightsResponse),
	CompletedFetchWebAnalytics: result(VercelWebAnalyticsResponse),
	CompletedFetchAuditLog: result(Schema.Array(VercelAuditEvent)),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	AttachedLinkedCursor: {},
	/** `useIntervalRefresh` while the projects are empty: the drains' first deliveries fill in on their own. */
	TickedEmptyRefresh: {},
	ClickedRetryStatus: {},
	ClickedRetryProjects: {},
	ClickedRetryBuckets: {},
	ClickedRetryLatency: {},
	ClickedRetryAiGateway: {},
	ClickedRetryDeployments: {},
	ClickedRetrySpeedInsights: {},
	ClickedRetryWebAnalytics: {},
	ClickedRetryAuditLog: {},
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	/** A fleet band cell: its health filter on the projects table, or none to leave it. */
	ClickedScope: { scope: Schema.optional(VercelProjectScope) },
	ClickedClearFilters: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

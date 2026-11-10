import {
	VercelAiGatewayResponse,
	VercelAuditEvent,
	VercelDeploymentSummary,
	VercelInfraProject,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
	VercelSpeedInsightsResponse,
	VercelWebAnalyticsResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraVercelSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"

// `/infra/vercel`: the team overview, or the projects list (`view=projects`).

export const SortKey = Schema.Literals([
	"name",
	"requests",
	"sortError",
	"sortCache",
	"sortColdStart",
	"sortP95",
	"errorLogs",
])
export type SortKey = typeof SortKey.Type

export const Model = Schema.Struct({
	search: InfraVercelSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(VercelIntegrationStatus, LoadFailure),
	projects: KeyedSchema(Schema.Array(VercelInfraProject), LoadFailure),
	/** The team's request series, for the headline's sparks. */
	buckets: KeyedSchema(Schema.Array(VercelInfraRequestBucket), LoadFailure),
	aiGateway: KeyedSchema(VercelAiGatewayResponse, LoadFailure),
	/** The team's newest deployments, from Vercel's API. */
	deployments: KeyedSchema(Schema.Array(VercelDeploymentSummary), LoadFailure),
	speedInsights: KeyedSchema(VercelSpeedInsightsResponse, LoadFailure),
	webAnalytics: KeyedSchema(VercelWebAnalyticsResponse, LoadFailure),
	auditLog: KeyedSchema(Schema.Array(VercelAuditEvent), LoadFailure),
	sort: sortStateOf(SortKey),
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
	CompletedFetchDeployments: result(Schema.Array(VercelDeploymentSummary)),
	CompletedFetchSpeedInsights: result(VercelSpeedInsightsResponse),
	CompletedFetchWebAnalytics: result(VercelWebAnalyticsResponse),
	CompletedFetchAuditLog: result(Schema.Array(VercelAuditEvent)),
	/** `useIntervalRefresh` while the projects are empty: the drains' first deliveries fill in on their own. */
	TickedEmptyRefresh: {},
	ClickedRetryStatus: {},
	ClickedRetryProjects: {},
	ClickedRetryBuckets: {},
	ClickedRetryAiGateway: {},
	ClickedRetryDeployments: {},
	ClickedRetrySpeedInsights: {},
	ClickedRetryWebAnalytics: {},
	ClickedRetryAuditLog: {},
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ClickedSort: { key: SortKey },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type

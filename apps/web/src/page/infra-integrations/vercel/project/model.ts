import {
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
	VercelInfraProject,
	VercelInfraProjectDetailResponse,
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
import { InfraVercelProjectSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"

// `/infra/vercel/$projectId`.

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
	detail: KeyedSchema(VercelInfraProjectDetailResponse, LoadFailure),
	deployments: KeyedSchema(Schema.Array(VercelDeploymentSummary), LoadFailure),
	aiGateway: KeyedSchema(VercelAiGatewayResponse, LoadFailure),
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
	CompletedFetchDetail: result(VercelInfraProjectDetailResponse),
	CompletedFetchDeployments: result(Schema.Array(VercelDeploymentSummary)),
	CompletedFetchAiGateway: result(VercelAiGatewayResponse),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedRetryRequests: {},
	ClickedRetryDetail: {},
	ClickedRetryDeployments: {},
	ClickedRetryAiGateway: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type

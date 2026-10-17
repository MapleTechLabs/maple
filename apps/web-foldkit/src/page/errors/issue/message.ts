import {
	ErrorIssueEventsResponse,
	ErrorIssuePullRequestsResponse,
	ErrorIssueVerificationsResponse,
	GithubIntegrationStatus,
	IssueEscalationAttemptsResponse,
	VcsPullRequestsResponse,
} from "@maple/domain/http"
import { V2AnomalyIncident, V2ErrorIssueDetail, V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as CopyButton from "../../../ui/copy-button"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { DestinationName } from "./model"

/** `Load` on entry or a window change; `Refresh` from Reload (no snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchDetail: result(V2ErrorIssueDetail),
	CompletedFetchEvents: result(ErrorIssueEventsResponse),
	CompletedFetchInvestigations: result(Schema.Array(V2Investigation)),
	CompletedFetchPullRequests: result(ErrorIssuePullRequestsResponse),
	CompletedFetchVerifications: result(ErrorIssueVerificationsResponse),
	CompletedFetchEscalations: result(IssueEscalationAttemptsResponse),
	CompletedFetchAnomalies: result(Schema.Array(V2AnomalyIncident)),
	CompletedFetchGithubStatus: result(GithubIntegrationStatus),
	CompletedFetchVcsPullRequests: result(VcsPullRequestsResponse),
	UpdatedDestinations: { orgId: Schema.String, destinations: Schema.Array(DestinationName) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: {},
	ClickedResetTimeRange: {},
	ClickedInvestigation: { id: Schema.String },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotStatusSelectMessage: { message: Select.Message },
	GotSeveritySelectMessage: { message: Select.Message },
	GotFingerprintCopyMessage: { message: CopyButton.Message },
	GotIssueIdCopyMessage: { message: CopyButton.Message },
	GotChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

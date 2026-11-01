import {
	ErrorIssueEventsResponse,
	ErrorIssuePullRequestsResponse,
	ErrorIssueVerificationsResponse,
	GithubIntegrationStatus,
	IssueEscalationAttemptsResponse,
	IssueSeverity,
	VcsPullRequestsResponse,
	WorkflowState,
} from "@maple/domain/http"
import { V2AnomalyIncident, V2ErrorIssueDetail, V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Combobox from "../../../ui/combobox"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
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

/** The issue workflow writes the rail sends (`useMutationAction` in the route). */
export const IssueWrite = Schema.Union([
	Schema.TaggedStruct("Transition", { toState: WorkflowState }),
	Schema.TaggedStruct("Claim", {}),
	Schema.TaggedStruct("Heartbeat", {}),
	Schema.TaggedStruct("Release", {}),
	Schema.TaggedStruct("SetSeverity", { severity: Schema.NullOr(IssueSeverity) }),
])
export type IssueWrite = typeof IssueWrite.Type

/** What the success toast reads off the written issue. */
export const WriteOutcome = Schema.Struct({ severity: Schema.NullOr(Schema.String) })

/** `evaluateEscalationPolicy`: whether the change would notify, and whom. */
export const EscalationPreview = Schema.Struct({
	outcome: Schema.String,
	destinationIds: Schema.Array(Schema.String),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchDetail: result(V2ErrorIssueDetail),
	CompletedFetchEvents: result(ErrorIssueEventsResponse),
	MountedRightRail: {},
	CompletedFetchInvestigations: result(Schema.Array(V2Investigation)),
	CompletedFetchPullRequests: result(ErrorIssuePullRequestsResponse),
	CompletedFetchVerifications: result(ErrorIssueVerificationsResponse),
	CompletedFetchEscalations: result(IssueEscalationAttemptsResponse),
	CompletedFetchAnomalies: result(Schema.Array(V2AnomalyIncident)),
	CompletedFetchGithubStatus: result(GithubIntegrationStatus),
	CompletedFetchVcsPullRequests: result(VcsPullRequestsResponse),
	UpdatedDestinations: { orgId: Schema.String, destinations: Schema.Array(DestinationName) },
	TickedLeaseClock: { nowMs: Schema.Number },
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
	GotPromptCopyMessage: { message: CopyButton.Message },
	GotChartMessage: { message: Chart.Message },
	ClickedClaim: {},
	ClickedExtendLease: {},
	ClickedReleaseLease: {},
	CompletedIssueWrite: { write: IssueWrite, result: Schema.Result(WriteOutcome, LoadFailure) },
	CompletedEvaluateEscalation: {
		severity: IssueSeverity,
		pick: Schema.Number,
		result: Schema.Result(EscalationPreview, LoadFailure),
	},
	GotSeverityConfirmMessage: { message: Dialog.Message },
	ClickedConfirmSeverity: {},
	ClickedInvestigate: {},
	ClickedAttach: {},
	ClickedShowEarlier: {},
	GotRepositorySelectMessage: { message: Select.Message },
	ChangedCommentDraft: { value: Schema.String },
	ClickedComment: {},
	ClickedRetryEvents: {},
	CompletedComment: { result: Schema.Result(Schema.Null, LoadFailure) },
	GotAttachDialogMessage: { message: Dialog.Message },
	ChangedAttachDraft: { value: Schema.String },
	GotAttachComboboxMessage: { message: Combobox.Message },
	SubmittedAttach: {},
	ClickedDetachPullRequest: { id: Schema.String },
	CompletedUnlinkPullRequest: { result: Schema.Result(Schema.Null, LoadFailure) },
	CompletedLinkPullRequest: { result: Schema.Result(Schema.Null, LoadFailure) },
	GotOverflowMenuMessage: { message: Menu.Message },
	CompletedCopy: { label: Schema.String, isOk: Schema.Boolean },
	CompletedCreateInvestigation: { result: Schema.Result(Schema.String, LoadFailure) },
})
export type Message = typeof Message.Type

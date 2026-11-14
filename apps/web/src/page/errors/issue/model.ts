import { ChartEnvFields } from "@maple/views/charts/chart-env"
import * as Policy from "@maple/domain/policy"
import {
	ErrorIssueAffectedUsersResponse,
	ErrorIssueEventsResponse,
	ErrorIssueId,
	ErrorIssuePullRequestsResponse,
	ErrorIssueVerificationsResponse,
	GithubIntegrationStatus,
	IssueEscalationAttemptsResponse,
	IssueSeverity,
	VcsPullRequestsResponse,
} from "@maple/domain/http"
import { V2AnomalyIncident, V2ErrorIssueDetail, V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ErrorIssueSearch } from "../../../route/search"
import * as Combobox from "@maple/views/ui/combobox"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"

const keyed = <A, AI>(schema: Schema.Codec<A, AI>) => KeyedSchema(schema, LoadFailure)

/** The alert destinations the escalation confirmation names. */
export const DestinationName = Schema.Struct({ id: Schema.String, name: Schema.String })

export const Model = Schema.Struct({
	issueId: ErrorIssueId,
	search: ErrorIssueSearch,
	/** What the viewer may do; an analyst reads the issue and gets no triage control. */
	grants: Schema.Array(Policy.PermissionName),
	/** The resolved window and the clock it was resolved at; `null` until the first resolve. */
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The lease countdown's clock, ticking once a second while a lease is held; 0 before its first tick. */
	leaseNowMs: Schema.Number,
	detail: keyed(V2ErrorIssueDetail),
	events: keyed(ErrorIssueEventsResponse),
	/** The rail's Affected users group, over the window. */
	affectedUsers: keyed(ErrorIssueAffectedUsersResponse),
	investigations: keyed(Schema.Array(V2Investigation)),
	pullRequests: keyed(ErrorIssuePullRequestsResponse),
	verifications: keyed(ErrorIssueVerificationsResponse),
	escalations: keyed(IssueEscalationAttemptsResponse),
	anomalies: keyed(Schema.Array(V2AnomalyIncident)),
	githubStatus: keyed(GithubIntegrationStatus),
	/** The issue rail mounted (inline, or in the sheet below `lg`): its attach dialog reads GitHub. */
	isRightRailMounted: Schema.Boolean,
	vcsPullRequests: keyed(VcsPullRequestsResponse),
	destinations: Schema.Array(DestinationName),
	timePicker: TimeRangePicker.Model,
	statusSelect: Select.Model,
	severitySelect: Select.Model,
	fingerprintCopy: CopyButton.Model,
	issueIdCopy: CopyButton.Model,
	/** The agent handoff panel's "Copy prompt". */
	promptCopy: CopyButton.Model,
	chart: Chart.Model,
	...ChartEnvFields,
	/** The rail writes in flight, one entry per write kind. */
	busy: Schema.Array(Schema.Literals(["state", "severity", "claim", "heartbeat", "release", "unmerge"])),
	isStartingInvestigation: Schema.Boolean,
	overflowMenu: Menu.Model,
	attachDialog: Dialog.Model,
	attachDraft: Schema.String,
	/** The repository picked in the attach dialog, over the suggestion. */
	attachRepository: Schema.NullOr(Schema.String),
	repositorySelect: Select.Model,
	/** The timeline mounts its rows before the latest 50 once asked. */
	isShowingEarlier: Schema.Boolean,
	attachCombobox: Combobox.Model,
	isAttaching: Schema.Boolean,
	isDetaching: Schema.Boolean,
	commentDraft: Schema.String,
	isCommenting: Schema.Boolean,
	severityConfirm: Dialog.Model,
	/** Counts severity picks; an escalation preview for an older pick is dropped. */
	severityPick: Schema.Number,
	pendingSeverity: Schema.NullOr(
		Schema.Struct({ severity: IssueSeverity, destinationNames: Schema.Array(Schema.String) }),
	),
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

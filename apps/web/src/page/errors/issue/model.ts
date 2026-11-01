import {
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
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ErrorIssueSearch } from "../../../route/search"
import * as Combobox from "../../../ui/combobox"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The issue detail page.

const keyed = <A, AI>(schema: Schema.Codec<A, AI>) => KeyedSchema(schema, LoadFailure)

/** The alert destinations the escalation confirmation names (`useAlertDestinationsList`). */
export const DestinationName = Schema.Struct({ id: Schema.String, name: Schema.String })

export const Model = Schema.Struct({
	issueId: ErrorIssueId,
	search: ErrorIssueSearch,
	/** The resolved window and the clock it was resolved at; `null` until the first resolve. */
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** `LeaseHud`'s own clock, ticking once a second while a lease is held; 0 before its first tick. */
	leaseNowMs: Schema.Number,
	detail: keyed(V2ErrorIssueDetail),
	events: keyed(ErrorIssueEventsResponse),
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
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** `PageRefreshProvider`: Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	/** The rail writes in flight, one entry per write kind. */
	busy: Schema.Array(Schema.Literals(["state", "severity", "claim", "heartbeat", "release"])),
	/** The severity raise waiting on "Notify escalation destinations?". */
	/** `startingInvestigation`: the create is in flight. */
	isStartingInvestigation: Schema.Boolean,
	overflowMenu: Menu.Model,
	attachDialog: Dialog.Model,
	attachDraft: Schema.String,
	/** `overrideRepository`: the repository picked in the attach dialog, over the suggestion. */
	attachRepository: Schema.NullOr(Schema.String),
	repositorySelect: Select.Model,
	/** `showEarlier`: the timeline mounts its rows before the latest 50 once asked. */
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

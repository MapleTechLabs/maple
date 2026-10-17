import {
	ErrorIssueEventsResponse,
	ErrorIssueId,
	ErrorIssuePullRequestsResponse,
	ErrorIssueVerificationsResponse,
	GithubIntegrationStatus,
	IssueEscalationAttemptsResponse,
	VcsPullRequestsResponse,
} from "@maple/domain/http"
import { V2AnomalyIncident, V2ErrorIssueDetail, V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ErrorIssueSearch } from "../../../route/search"
import * as CopyButton from "../../../ui/copy-button"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The issue detail page (apps/web/src/routes/errors/issues/$issueId.tsx).

const keyed = <A, AI>(schema: Schema.Codec<A, AI>) => KeyedSchema(schema, LoadFailure)

/** The alert destinations the escalation confirmation names (`useAlertDestinationsList`). */
export const DestinationName = Schema.Struct({ id: Schema.String, name: Schema.String })

export const Model = Schema.Struct({
	issueId: ErrorIssueId,
	search: ErrorIssueSearch,
	/** The resolved window and the clock it was resolved at; `null` until the first resolve. */
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	detail: keyed(V2ErrorIssueDetail),
	events: keyed(ErrorIssueEventsResponse),
	investigations: keyed(Schema.Array(V2Investigation)),
	pullRequests: keyed(ErrorIssuePullRequestsResponse),
	verifications: keyed(ErrorIssueVerificationsResponse),
	escalations: keyed(IssueEscalationAttemptsResponse),
	anomalies: keyed(Schema.Array(V2AnomalyIncident)),
	githubStatus: keyed(GithubIntegrationStatus),
	vcsPullRequests: keyed(VcsPullRequestsResponse),
	destinations: Schema.Array(DestinationName),
	timePicker: TimeRangePicker.Model,
	statusSelect: Select.Model,
	severitySelect: Select.Model,
	fingerprintCopy: CopyButton.Model,
	issueIdCopy: CopyButton.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** `PageRefreshProvider`: Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

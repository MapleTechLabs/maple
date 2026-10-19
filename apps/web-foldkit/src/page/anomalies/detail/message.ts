import { ErrorIssueId } from "@maple/domain/http"
import { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2ErrorIssue } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchIncident: { key: Schema.String, result: Schema.Result(V2AnomalyIncident, LoadFailure) },
	CompletedFetchTimeseries: {
		key: Schema.String,
		result: Schema.Result(V2AnomalyIncidentTimeseries, LoadFailure),
	},
	CompletedFetchLinkedIssue: { key: Schema.String, result: Schema.Result(V2ErrorIssue, LoadFailure) },
	CompletedFetchLinkIssues: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(V2ErrorIssue), LoadFailure),
	},
	/** Each live tick reads the clock, so relative times age with the data. */
	TickedLiveRefresh: { nowMs: Schema.Number },
	ClickedRetry: {},
	ClickedInvestigate: {},
	CompletedInvestigate: { result: Schema.Result(Schema.String, LoadFailure) },
	ClickedResolve: {},
	ClickedConfirmResolve: {},
	CompletedResolve: { result: Schema.Result(V2AnomalyIncident, LoadFailure) },
	ClickedLinkIssue: {},
	ClickedUnlink: {},
	SelectedLinkIssue: { issueId: ErrorIssueId },
	CompletedSetIssue: {
		issueId: Schema.NullOr(ErrorIssueId),
		result: Schema.Result(V2AnomalyIncident, LoadFailure),
	},
	GotLinkComboboxMessage: { message: Combobox.Message },
	ToggledLinkScope: {},
	GotResolveDialogMessage: { message: Dialog.Message },
	GotLinkDialogMessage: { message: Dialog.Message },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

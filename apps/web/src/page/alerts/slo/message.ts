import * as Policy from "@maple/domain/policy"
import { V2Slo, V2SloHistory, V2SloStatus } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSlo: { key: Schema.String, result: outcome(V2Slo) },
	CompletedFetchStatus: { key: Schema.String, result: outcome(V2SloStatus) },
	CompletedFetchHistory: { key: Schema.String, result: outcome(V2SloHistory) },
	ClickedRetry: {},
	ClickedRetryStatus: {},
	ClickedRetryHistory: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	UpdatedIncidents: { orgId: Schema.String, rows: Schema.Array(AlertIncidentRowSchema) },
	FailedLoadIncidents: { orgId: Schema.String },
	ClickedRetryIncidents: {},
	CompletedFetchSession: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
	ClickedToggleAlerting: {},
	CompletedToggleAlerting: { result: outcome(V2Slo) },
	ClickedDelete: {},
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { result: outcome(Schema.Void) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotBudgetChartMessage: { message: Chart.Message },
	GotSliChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

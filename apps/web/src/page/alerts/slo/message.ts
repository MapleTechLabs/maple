import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { V2Slo, V2SloHistory, V2SloStatus } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import * as Dialog from "@maple/views/ui/dialog"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSlo: { key: Schema.String, result: LoadOutcome(V2Slo) },
	CompletedFetchStatus: { key: Schema.String, result: LoadOutcome(V2SloStatus) },
	CompletedFetchHistory: { key: Schema.String, result: LoadOutcome(V2SloHistory) },
	ClickedRetry: {},
	ClickedRetryStatus: {},
	ClickedRetryHistory: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	UpdatedIncidents: { orgId: Schema.String, rows: Schema.Array(AlertIncidentRowSchema) },
	FailedLoadIncidents: { orgId: Schema.String },
	ClickedRetryIncidents: {},
	CompletedFetchSession: SessionGrants,
	ClickedToggleAlerting: {},
	CompletedToggleAlerting: { result: LoadOutcome(V2Slo) },
	ClickedDelete: {},
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { result: LoadOutcome(Schema.Void) },
	...ChartEnvMessages,
	GotBudgetChartMessage: { message: Chart.Message },
	GotSliChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

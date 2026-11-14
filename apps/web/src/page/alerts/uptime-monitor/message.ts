import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { V2UptimeMonitor, V2UptimeMonitorTestResult } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import * as CopyButton from "@maple/views/ui/copy-button"
import { CheckStats, UptimeWindow } from "./model"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchMonitor: { key: Schema.String, result: LoadOutcome(V2UptimeMonitor) },
	ClickedRetry: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	UpdatedIncidents: { orgId: Schema.String, rows: Schema.Array(AlertIncidentRowSchema) },
	CompletedFetchSession: SessionGrants,
	ClickedToggle: {},
	CompletedToggle: { result: LoadOutcome(V2UptimeMonitor) },
	ClickedCheckNow: {},
	CompletedCheckNow: { result: LoadOutcome(V2UptimeMonitorTestResult) },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
	PickedWindow: { window: UptimeWindow },
	HoveredCheck: { index: Schema.NullOr(Schema.Number) },
	CompletedFetchStats: { key: Schema.String, result: LoadOutcome(CheckStats) },
	...ChartEnvMessages,
	GotChartMessage: { message: Chart.Message },
	GotPhaseChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

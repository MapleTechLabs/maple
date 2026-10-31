import { V2UptimeMonitor, V2UptimeMonitorTestResult } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import { CheckStats, UptimeWindow } from "./model"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchMonitor: { key: Schema.String, result: outcome(V2UptimeMonitor) },
	ClickedRetry: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	UpdatedIncidents: { orgId: Schema.String, rows: Schema.Array(AlertIncidentRowSchema) },
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	ClickedToggle: {},
	CompletedToggle: { result: outcome(V2UptimeMonitor) },
	ClickedCheckNow: {},
	CompletedCheckNow: { result: outcome(V2UptimeMonitorTestResult) },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
	PickedWindow: { window: UptimeWindow },
	HoveredCheck: { index: Schema.NullOr(Schema.Number) },
	CompletedFetchStats: { key: Schema.String, result: outcome(CheckStats) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
	GotPhaseChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type

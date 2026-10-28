import { UptimeMonitorId } from "@maple/domain"
import { AlertDeliveryEventDocument, AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { V2UptimeMonitor } from "@maple/domain/http/v2"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as DestinationDialog from "../destination/dialog"
import * as StatusPages from "../status-pages/list"
import { TestOutcome, UptimeKindFilter, UptimeStatusFilter } from "./model"
import { ServiceNamespaces } from "./uptime-groups"

export const RuleBucket = Schema.Literals(["firing", "blind", "healthy", "disabled"])
export type RuleBucket = typeof RuleBucket.Type

const rows = <S extends Schema.Top>(row: S) => ({ orgId: Schema.String, rows: Schema.Array(row) })
const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	UpdatedRules: rows(AlertRuleRowSchema),
	UpdatedRuleStates: rows(AlertRuleStateRowSchema),
	UpdatedIncidents: rows(AlertIncidentRowSchema),
	UpdatedDestinations: rows(AlertDestinationRowSchema),
	FailedLoadAlerts: { orgId: Schema.String },
	ClickedRetryLoad: {},
	CompletedFetchDeliveries: {
		key: Schema.String,
		result: outcome(Schema.Array(AlertDeliveryEventDocument)),
	},
	CompletedFetchRoutingDeliveries: {
		key: Schema.String,
		result: outcome(Schema.Array(AlertDeliveryEventDocument)),
	},
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	ChangedRulesQuery: { value: Schema.String },
	ClickedStatusFilter: { bucket: RuleBucket },
	ClickedClearRuleFilters: {},
	ClickedShowAllRules: {},
	ClickedToggleRule: { ruleId: AlertRuleId, isEnabled: Schema.Boolean },
	CompletedToggleRule: { ruleId: AlertRuleId, result: outcome(Schema.Void) },
	ClickedToggleDestination: { destinationId: AlertDestinationId },
	CompletedUpdateDestination: { destinationId: AlertDestinationId, result: outcome(Schema.Void) },
	ClickedTestDestination: { destinationId: AlertDestinationId },
	CompletedTestDestination: { destinationId: AlertDestinationId, result: outcome(TestOutcome) },
	ClickedConfirmDeleteDestination: {},
	CompletedDeleteDestination: { destinationId: AlertDestinationId, result: outcome(Schema.Void) },
	ClickedNewDestination: {},
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	FailedLoadProviderLogo: { type: Schema.String },
	GotDestinationDialogMessage: { message: DestinationDialog.Message },
	GotNewRuleMenuMessage: { message: Menu.Message },
	CompletedFetchMonitors: { key: Schema.String, result: outcome(Schema.Array(V2UptimeMonitor)) },
	ClickedRetryMonitors: {},
	CompletedFetchServiceNamespaces: { key: Schema.String, result: outcome(ServiceNamespaces) },
	ChangedUptimeQuery: { value: Schema.String },
	ClickedUptimeStatus: { filter: UptimeStatusFilter },
	ChangedUptimeKind: { kind: UptimeKindFilter },
	ClickedClearUptimeFilters: {},
	CompletedToggleMonitor: { monitorId: UptimeMonitorId, result: outcome(V2UptimeMonitor) },
	ClickedConfirmDeleteMonitor: {},
	CompletedDeleteMonitor: { monitorId: UptimeMonitorId, result: outcome(Schema.Void) },
	GotDeleteMonitorDialogMessage: { message: Dialog.Message },
	GotStatusPagesMessage: { message: StatusPages.Message },
})
export type Message = typeof Message.Type

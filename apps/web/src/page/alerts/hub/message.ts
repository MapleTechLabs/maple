import * as Policy from "@maple/domain/policy"
import { UptimeMonitorId } from "@maple/domain"
import {
	AlertDeliveryEventDocument,
	AlertDestinationId,
	AlertIncidentId,
	AlertRuleId,
	AlertSilenceId,
	EscalationChainId,
	OnCallScheduleId,
} from "@maple/domain/http"
import {
	V2AlertIncident,
	V2AlertSilence,
	V2EscalationChain,
	V2OnCallSchedule,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as DestinationDialog from "../destination/dialog"
import * as ChainDialog from "../escalation-dialog/dialog"
import { OrgMember } from "../shared/org-members"
import * as SilenceDialog from "../silence-dialog/dialog"
import { SloListRow, TestOutcome, UptimeKindFilter, UptimeStatusFilter } from "./model"
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
	CompletedFetchSession: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
	ChangedRulesQuery: { value: Schema.String },
	ClickedStatusFilter: { bucket: RuleBucket },
	ClickedClearRuleFilters: {},
	ClickedShowAllRules: {},
	ClickedToggleRule: { ruleId: AlertRuleId, isEnabled: Schema.Boolean },
	CompletedToggleRule: { ruleId: AlertRuleId, result: outcome(Schema.Void) },
	ClickedAcknowledgeIncident: { incidentId: AlertIncidentId, acknowledged: Schema.Boolean },
	CompletedAcknowledgeIncident: {
		incidentId: AlertIncidentId,
		acknowledged: Schema.Boolean,
		result: outcome(V2AlertIncident),
	},
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
	CompletedFetchSlos: { key: Schema.String, result: outcome(Schema.Array(SloListRow)) },
	ClickedRetrySlos: {},
	CompletedFetchChains: { key: Schema.String, result: outcome(Schema.Array(V2EscalationChain)) },
	ClickedRetryChains: {},
	ClickedNewChain: {},
	GotChainDialogMessage: { message: ChainDialog.Message },
	ClickedConfirmDeleteChain: {},
	CompletedDeleteChain: { chainId: EscalationChainId, result: outcome(Schema.Void) },
	GotDeleteChainDialogMessage: { message: Dialog.Message },
	CompletedFetchSchedules: {
		key: Schema.String,
		readAtMs: Schema.Number,
		result: outcome(Schema.Array(V2OnCallSchedule)),
	},
	ClickedRetrySchedules: {},
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	ClickedConfirmDeleteSchedule: {},
	CompletedDeleteSchedule: { scheduleId: OnCallScheduleId, result: outcome(Schema.Void) },
	GotDeleteScheduleDialogMessage: { message: Dialog.Message },
	CompletedFetchSilences: { key: Schema.String, result: outcome(Schema.Array(V2AlertSilence)) },
	ClickedRetrySilences: {},
	ClickedNewSilence: {},
	GotSilenceDialogMessage: { message: SilenceDialog.Message },
	ClickedEndSilence: { silenceId: AlertSilenceId },
	CompletedEndSilence: { silenceId: AlertSilenceId, result: outcome(V2AlertSilence) },
})
export type Message = typeof Message.Type

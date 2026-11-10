import { UptimeMonitorId } from "@maple/domain"
import {
	AlertDeliveryEventDocument,
	AlertDestinationId,
	AlertIncidentId,
	AlertMaintenanceWindowId,
	AlertRuleId,
	AlertSilenceId,
	EscalationChainId,
	OnCallScheduleId,
} from "@maple/domain/http"
import {
	V2AlertIncident,
	V2AlertMaintenanceWindow,
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
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as DestinationDialog from "../destination/dialog"
import * as ChainDialog from "../escalation-dialog/dialog"
import { OrgMember } from "../shared/org-members"
import * as WindowDialog from "../maintenance-dialog/dialog"
import * as SilenceDialog from "../silence-dialog/dialog"
import { SloListRow, TestOutcome, UptimeKindFilter, UptimeStatusFilter } from "./model"
import { ServiceNamespaces } from "./uptime-groups"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const RuleBucket = Schema.Literals(["firing", "blind", "healthy", "disabled"])
export type RuleBucket = typeof RuleBucket.Type

/** The Inbox's signal view: every incident, or anomalies alone. */
export const InboxSignal = Schema.NullOr(Schema.Literal("anomaly"))
export type InboxSignal = typeof InboxSignal.Type

/** Which incidents a signal view lists. */
export const IncidentStatusFilter = Schema.Literals(["open", "resolved", "all"])
export type IncidentStatusFilter = typeof IncidentStatusFilter.Type

const rows = <S extends Schema.Top>(row: S) => ({ orgId: Schema.String, rows: Schema.Array(row) })

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
		result: LoadOutcome(Schema.Array(AlertDeliveryEventDocument)),
	},
	CompletedFetchRoutingDeliveries: {
		key: Schema.String,
		result: LoadOutcome(Schema.Array(AlertDeliveryEventDocument)),
	},
	CompletedFetchSession: SessionGrants,
	ChangedRulesQuery: { value: Schema.String },
	ClickedStatusFilter: { bucket: RuleBucket },
	ClickedClearRuleFilters: {},
	ClickedInboxSignal: { signal: InboxSignal },
	ClickedIncidentStatus: { status: IncidentStatusFilter },
	ClickedClearInboxService: {},
	ClickedShowAllRules: {},
	ClickedToggleRule: { ruleId: AlertRuleId, isEnabled: Schema.Boolean },
	CompletedToggleRule: { ruleId: AlertRuleId, result: LoadOutcome(Schema.Void) },
	ClickedAcknowledgeIncident: { incidentId: AlertIncidentId, acknowledged: Schema.Boolean },
	CompletedAcknowledgeIncident: {
		incidentId: AlertIncidentId,
		acknowledged: Schema.Boolean,
		result: LoadOutcome(V2AlertIncident),
	},
	ClickedToggleDestination: { destinationId: AlertDestinationId },
	CompletedUpdateDestination: { destinationId: AlertDestinationId, result: LoadOutcome(Schema.Void) },
	ClickedTestDestination: { destinationId: AlertDestinationId },
	CompletedTestDestination: { destinationId: AlertDestinationId, result: LoadOutcome(TestOutcome) },
	ClickedConfirmDeleteDestination: {},
	CompletedDeleteDestination: { destinationId: AlertDestinationId, result: LoadOutcome(Schema.Void) },
	ClickedNewDestination: {},
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	FailedLoadProviderLogo: { type: Schema.String },
	GotDestinationDialogMessage: { message: DestinationDialog.Message },
	GotNewRuleMenuMessage: { message: Menu.Message },
	CompletedFetchMonitors: { key: Schema.String, result: LoadOutcome(Schema.Array(V2UptimeMonitor)) },
	ClickedRetryMonitors: {},
	CompletedFetchServiceNamespaces: { key: Schema.String, result: LoadOutcome(ServiceNamespaces) },
	ChangedUptimeQuery: { value: Schema.String },
	ClickedUptimeStatus: { filter: UptimeStatusFilter },
	ChangedUptimeKind: { kind: UptimeKindFilter },
	ClickedClearUptimeFilters: {},
	CompletedToggleMonitor: { monitorId: UptimeMonitorId, result: LoadOutcome(V2UptimeMonitor) },
	ClickedConfirmDeleteMonitor: {},
	CompletedDeleteMonitor: { monitorId: UptimeMonitorId, result: LoadOutcome(Schema.Void) },
	GotDeleteMonitorDialogMessage: { message: Dialog.Message },
	CompletedFetchSlos: { key: Schema.String, result: LoadOutcome(Schema.Array(SloListRow)) },
	ClickedRetrySlos: {},
	CompletedFetchChains: { key: Schema.String, result: LoadOutcome(Schema.Array(V2EscalationChain)) },
	ClickedRetryChains: {},
	ClickedNewChain: {},
	GotChainDialogMessage: { message: ChainDialog.Message },
	ClickedConfirmDeleteChain: {},
	CompletedDeleteChain: { chainId: EscalationChainId, result: LoadOutcome(Schema.Void) },
	GotDeleteChainDialogMessage: { message: Dialog.Message },
	CompletedFetchSchedules: {
		key: Schema.String,
		readAtMs: Schema.Number,
		result: LoadOutcome(Schema.Array(V2OnCallSchedule)),
	},
	ClickedRetrySchedules: {},
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	ClickedConfirmDeleteSchedule: {},
	CompletedDeleteSchedule: { scheduleId: OnCallScheduleId, result: LoadOutcome(Schema.Void) },
	GotDeleteScheduleDialogMessage: { message: Dialog.Message },
	CompletedFetchSilences: { key: Schema.String, result: LoadOutcome(Schema.Array(V2AlertSilence)) },
	ClickedRetrySilences: {},
	ClickedNewSilence: {},
	GotSilenceDialogMessage: { message: SilenceDialog.Message },
	ClickedEndSilence: { silenceId: AlertSilenceId },
	CompletedEndSilence: { silenceId: AlertSilenceId, result: LoadOutcome(V2AlertSilence) },
	CompletedFetchWindows: {
		key: Schema.String,
		result: LoadOutcome(Schema.Array(V2AlertMaintenanceWindow)),
	},
	ClickedRetryWindows: {},
	ClickedNewWindow: {},
	GotWindowDialogMessage: { message: WindowDialog.Message },
	ClickedToggleWindow: { windowId: AlertMaintenanceWindowId },
	CompletedToggleWindow: {
		windowId: AlertMaintenanceWindowId,
		result: LoadOutcome(V2AlertMaintenanceWindow),
	},
	ClickedConfirmDeleteWindow: {},
	CompletedDeleteWindow: { windowId: AlertMaintenanceWindowId, result: LoadOutcome(Schema.Void) },
	GotDeleteWindowDialogMessage: { message: Dialog.Message },
	ClickedClearWindowFilter: {},
})
export type Message = typeof Message.Type

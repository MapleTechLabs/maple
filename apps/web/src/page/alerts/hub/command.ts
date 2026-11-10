import { readClock } from "@maple/views/data/timing"
import { UptimeMonitorId } from "@maple/domain"
import {
	AlertDestinationId,
	AlertIncidentId,
	AlertMaintenanceWindowId,
	AlertRuleId,
	AlertSilenceId,
	EscalationChainId,
	OnCallScheduleId,
} from "@maple/domain/http"
import { V2AlertDestinationUpdateParams } from "@maple/domain/http/v2"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Cause, Clock, Effect, Schema } from "effect"
import { IdleTtl } from "../../../data/idle-ttl"
import { readThrough } from "../../../data/read-cache"
import { toLoadFailure, settleTo } from "@maple/views/data/load-failure"
import { Command } from "foldkit"
import { dismissSheetUrl, pushSheetUrl } from "../../kit/sheet-param"
import {
	deleteDestination,
	listDeliveries,
	listDeliveriesRaw,
	setRuleEnabled,
	testDestination,
	updateDestination,
	setIncidentAcknowledged,
} from "../shared/commands"
import { deleteEscalationChain, listEscalationChains } from "../shared/escalation-chains"
import { deleteOnCallSchedule, listOnCallSchedules } from "../shared/oncall-schedules"
import { listOrgMembers } from "../shared/org-members"
import { listSloRows } from "../shared/slo-commands"
import { deleteMonitor, listMonitors, setMonitorEnabled } from "../../kit/uptime/commands"
import { endSilence, listSilences } from "../shared/silences"
import {
	deleteMaintenanceWindow,
	listMaintenanceWindows,
	listWindowSilences,
	updateMaintenanceWindow,
} from "../shared/maintenance-windows"
import { Message } from "./message"
import { ServiceNamespaces, serviceNamespaces } from "./uptime-groups"
import { fetchSessionGrants } from "../../kit/session-grants"

const sheetArgs = { href: Schema.String, id: Schema.String }

/** A command must answer with a message: a sheet change answers with the clock, as a route change reads it. */
const thenReadClock = (effect: Effect.Effect<void>) =>
	effect.pipe(
		Effect.andThen(Clock.currentTimeMillis),
		Effect.map((nowMs) => Message.ReadClock({ nowMs })),
	)

/** Opens a side panel: a history entry carrying `?sheet=`, marked as this tab's. */
export const PushHubSheet = Command.define("PushAlertsHubSheet", {
	args: sheetArgs,
	messages: [Message.ReadClock],
	execute: ({ href, id }) => thenReadClock(pushSheetUrl(href, id)),
})

/** Closes it: Back over the entry this tab pushed, else `?sheet=` replaced away. */
export const DismissHubSheet = Command.define("DismissAlertsHubSheet", {
	args: sheetArgs,
	messages: [Message.ReadClock],
	execute: ({ href, id }) => thenReadClock(dismissSheetUrl(href, id)),
})

export const ReadHubClock = readClock("ReadAlertsHubClock", Message.ReadClock)

export const FetchHubDeliveries = Command.define("FetchAlertsHubDeliveries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDeliveries],
	execute: ({ key }) =>
		listDeliveries().pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDeliveries({ key, result })),
		),
})

/**
 * The Routing tab renders the read's failure, which can carry no typed one
 * (observed: "An unexpected error occurred" for a 500), so the slot keeps the unexpected body too.
 */
export const FetchRoutingDeliveries = Command.define("FetchAlertsRoutingDeliveries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchRoutingDeliveries],
	execute: ({ key }) =>
		listDeliveriesRaw().pipe(
			Effect.mapError((error) => toLoadFailure(Cause.die(error))),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRoutingDeliveries({ key, result })),
		),
})

export const FetchHubSession = fetchSessionGrants("FetchAlertsHubSession", Message.CompletedFetchSession)

export const ToggleRule = Command.define("ToggleAlertRule", {
	args: { ruleId: AlertRuleId, isEnabled: Schema.Boolean },
	messages: [Message.CompletedToggleRule],
	execute: ({ ruleId, isEnabled }) =>
		setRuleEnabled(ruleId, isEnabled).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggleRule({ ruleId, result })),
		),
})

export const AcknowledgeIncident = Command.define("AcknowledgeAlertIncident", {
	args: { incidentId: AlertIncidentId, acknowledged: Schema.Boolean },
	messages: [Message.CompletedAcknowledgeIncident],
	execute: ({ incidentId, acknowledged }) =>
		setIncidentAcknowledged(incidentId, acknowledged).pipe(
			Effect.result,
			Effect.map((result) =>
				Message.CompletedAcknowledgeIncident({ incidentId, acknowledged, result }),
			),
		),
})

/** The row's toggle and the dialog's save: PATCH the destination. */
export const UpdateDestination = Command.define("UpdateAlertDestination", {
	args: { destinationId: AlertDestinationId, payload: V2AlertDestinationUpdateParams },
	messages: [Message.CompletedUpdateDestination],
	execute: ({ destinationId, payload }) =>
		updateDestination(destinationId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedUpdateDestination({ destinationId, result })),
		),
})

export const TestDestination = Command.define("TestAlertDestination", {
	args: { destinationId: AlertDestinationId },
	messages: [Message.CompletedTestDestination],
	execute: ({ destinationId }) =>
		testDestination(destinationId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedTestDestination({ destinationId, result })),
		),
})

export const DeleteDestination = Command.define("DeleteAlertDestination", {
	args: { destinationId: AlertDestinationId },
	messages: [Message.CompletedDeleteDestination],
	execute: ({ destinationId }) =>
		deleteDestination(destinationId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteDestination({ destinationId, result })),
		),
})

export const FetchHubMonitors = Command.define("FetchAlertsHubMonitors", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMonitors],
	execute: ({ key }) =>
		listMonitors.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitors({ key, result })),
		),
})

/** Each service's namespace over the last day, on the cache-snapped range the namespace switcher reads. */
export const FetchServiceNamespaces = Command.define("FetchAlertsHubServiceNamespaces", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchServiceNamespaces],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const range = snapRangeForCache({
				startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			})
			return yield* readThrough(
				{ key, refresh: false, idleTtlMs: IdleTtl.serviceOverview, schema: ServiceNamespaces },
				Effect.map(getServiceOverview({ data: range }), (response) =>
					serviceNamespaces(response.data),
				),
			)
		}).pipe(settleTo((result) => Message.CompletedFetchServiceNamespaces({ key, result }))),
})

export const ToggleMonitor = Command.define("ToggleUptimeMonitor", {
	args: { monitorId: UptimeMonitorId, enabled: Schema.Boolean },
	messages: [Message.CompletedToggleMonitor],
	execute: ({ monitorId, enabled }) =>
		setMonitorEnabled(monitorId, enabled).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggleMonitor({ monitorId, result })),
		),
})

export const DeleteMonitor = Command.define("DeleteUptimeMonitor", {
	args: { monitorId: UptimeMonitorId },
	messages: [Message.CompletedDeleteMonitor],
	execute: ({ monitorId }) =>
		deleteMonitor(monitorId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteMonitor({ monitorId, result })),
		),
})

export const FetchHubSlos = Command.define("FetchAlertsHubSlos", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSlos],
	execute: ({ key }) =>
		listSloRows.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSlos({ key, result })),
		),
})

export const FetchHubChains = Command.define("FetchAlertsHubChains", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchChains],
	execute: ({ key }) =>
		listEscalationChains.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchChains({ key, result })),
		),
})

export const DeleteChain = Command.define("DeleteEscalationChain", {
	args: { chainId: EscalationChainId },
	messages: [Message.CompletedDeleteChain],
	execute: ({ chainId }) =>
		deleteEscalationChain(chainId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteChain({ chainId, result })),
		),
})

/** The on-call schedules, each with who is on call as the API reads it now. */
export const FetchHubSchedules = Command.define("FetchAlertsHubSchedules", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSchedules],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const result = yield* Effect.result(listOnCallSchedules)
			const readAtMs = yield* Clock.currentTimeMillis
			return Message.CompletedFetchSchedules({ key, readAtMs, result })
		}),
})

/** The org's members, to name who is on call and to pick from in the chain dialog. */
export const FetchHubMembers = Command.define("FetchAlertsHubMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: listOrgMembers.pipe(
		Effect.result,
		Effect.map((result) => Message.CompletedFetchMembers({ result })),
	),
})

export const DeleteSchedule = Command.define("DeleteOnCallSchedule", {
	args: { scheduleId: OnCallScheduleId },
	messages: [Message.CompletedDeleteSchedule],
	execute: ({ scheduleId }) =>
		deleteOnCallSchedule(scheduleId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteSchedule({ scheduleId, result })),
		),
})

/** The org's silences, or every silence one maintenance window wrote. */
export const FetchHubSilences = Command.define("FetchAlertsHubSilences", {
	args: { key: Schema.String, windowId: Schema.NullOr(AlertMaintenanceWindowId) },
	messages: [Message.CompletedFetchSilences],
	execute: ({ key, windowId }) =>
		(windowId === null ? listSilences : listWindowSilences(windowId)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSilences({ key, result })),
		),
})

export const EndHubSilence = Command.define("EndAlertSilence", {
	args: { silenceId: AlertSilenceId },
	messages: [Message.CompletedEndSilence],
	execute: ({ silenceId }) =>
		endSilence(silenceId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedEndSilence({ silenceId, result })),
		),
})

export const FetchHubWindows = Command.define("FetchAlertsHubMaintenanceWindows", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchWindows],
	execute: ({ key }) =>
		listMaintenanceWindows.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWindows({ key, result })),
		),
})

export const ToggleWindow = Command.define("ToggleMaintenanceWindow", {
	args: { windowId: AlertMaintenanceWindowId, enabled: Schema.Boolean },
	messages: [Message.CompletedToggleWindow],
	execute: ({ windowId, enabled }) =>
		updateMaintenanceWindow(windowId, { enabled }).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggleWindow({ windowId, result })),
		),
})

export const DeleteWindow = Command.define("DeleteMaintenanceWindow", {
	args: { windowId: AlertMaintenanceWindowId },
	messages: [Message.CompletedDeleteWindow],
	execute: ({ windowId }) =>
		deleteMaintenanceWindow(windowId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteWindow({ windowId, result })),
		),
})

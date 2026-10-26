import { UptimeMonitorId } from "@maple/domain"
import { AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { V2AlertDestinationUpdateParams } from "@maple/domain/http/v2"
import { Cause, Clock, Effect, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { Command } from "foldkit"
import {
	deleteDestination,
	listDeliveries,
	listDeliveriesRaw,
	readIsAdmin,
	setRuleEnabled,
	testDestination,
	updateDestination,
} from "../shared/commands"
import { deleteMonitor, listMonitors, setMonitorEnabled } from "../shared/uptime-commands"
import { Message } from "./message"

export const ReadHubClock = Command.define("ReadAlertsHubClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

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
 * The Routing tab renders `deliveryEventsResult.cause`, which can carry no typed failure
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

export const FetchHubSession = Command.define("FetchAlertsHubSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchSession({ orgId, isAdmin })),
})

export const ToggleRule = Command.define("ToggleAlertRule", {
	args: { ruleId: AlertRuleId, isEnabled: Schema.Boolean },
	messages: [Message.CompletedToggleRule],
	execute: ({ ruleId, isEnabled }) =>
		setRuleEnabled(ruleId, isEnabled).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggleRule({ ruleId, result })),
		),
})

/** `DestinationManager.toggle` and the dialog's save: PATCH the destination. */
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

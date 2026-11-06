import type { AlertDestinationId, AlertIncidentId, AlertRuleId } from "@maple/domain/http"
import type { V2AlertDestinationUpdateParams, V2AlertIncident } from "@maple/domain/http/v2"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { v2DeliveryToDocument } from "@maple/web-data/alerts/form-utils"
import { Effect, Array as Arr } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The alert reads and writes the hub, rule and incident pages share, as Effects their Commands wrap.

/** `alertDeliveries.list({ limit: 100 })` (optionally one incident's), as documents. */
export const listDeliveriesRaw = (incidentId?: AlertIncidentId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.alertDeliveries.list({
			query: incidentId === undefined ? { limit: 100 } : { incident_id: incidentId, limit: 100 },
		})
		return Arr.map(response.data, v2DeliveryToDocument)
	})

export const listDeliveries = (incidentId?: AlertIncidentId) =>
	listDeliveriesRaw(incidentId).pipe(Effect.mapError(toLoadFailure))

/** `toggleRuleHandler`: PATCH the rule's `enabled`. */
export const setRuleEnabled = (ruleId: AlertRuleId, isEnabled: boolean) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.alertRules.update({ params: { id: ruleId }, payload: { enabled: isEnabled } })
	}).pipe(Effect.mapError(toLoadFailure))

export const updateDestination = (
	destinationId: AlertDestinationId,
	payload: V2AlertDestinationUpdateParams,
) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const params = { id: destinationId }
		// The client takes one request type per union member, so each narrowed payload is sent on its own.
		switch (payload.type) {
			case "pagerduty":
				return yield* client.alertDestinations.update({ params, payload })
			case "webhook":
				return yield* client.alertDestinations.update({ params, payload })
			case "discord":
				return yield* client.alertDestinations.update({ params, payload })
			case "telegram":
				return yield* client.alertDestinations.update({ params, payload })
			case "google-chat":
				return yield* client.alertDestinations.update({ params, payload })
			case "email":
				return yield* client.alertDestinations.update({ params, payload })
			case "chat":
				return yield* client.alertDestinations.update({ params, payload })
			case "linear":
				return yield* client.alertDestinations.update({ params, payload })
		}
	}).pipe(Effect.asVoid, Effect.mapError(toLoadFailure))

export const testDestination = (destinationId: AlertDestinationId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const result = yield* client.alertDestinations.test({ params: { id: destinationId } })
		return { message: result.message, success: result.success }
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteDestination = (destinationId: AlertDestinationId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.alertDestinations.delete({ params: { id: destinationId } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Acknowledge or unacknowledge an open incident; the updated incident comes back. */
export const setIncidentAcknowledged = (incidentId: AlertIncidentId, acknowledged: boolean) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const params = { params: { id: incidentId } }
		return yield* acknowledged
			? client.alertIncidents.acknowledge(params)
			: client.alertIncidents.unacknowledge(params)
	}).pipe(Effect.mapError(toLoadFailure))

/** The incident's acknowledgement history, oldest first. */
export const listIncidentActivity = (incidentId: AlertIncidentId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.alertIncidents.listEvents({ params: { id: incidentId } })
		return response.data
	}).pipe(Effect.mapError(toLoadFailure))

/**
 * The synced row with the acknowledgement a request just returned, so the page shows it before
 * the sync catches up with the same values.
 */
export const withAcknowledgement = <R extends AlertIncidentRow>(
	rows: ReadonlyArray<R>,
	incident: V2AlertIncident,
) =>
	Arr.map(rows, (row) =>
		row.id === incident.id
			? {
					...row,
					acknowledged_at: incident.acknowledged_at,
					acknowledged_by_user_id: incident.acknowledged_by?.user_id ?? null,
					acknowledged_by_name: incident.acknowledged_by?.name ?? null,
					acknowledged_via: incident.acknowledged_via,
				}
			: row,
	)

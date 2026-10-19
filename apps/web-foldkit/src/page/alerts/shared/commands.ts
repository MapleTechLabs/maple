import type { AlertDestinationId, AlertIncidentId, AlertRuleId } from "@maple/domain/http"
import type { V2AlertDestinationUpdateParams } from "@maple/domain/http/v2"
import { v2DeliveryToDocument } from "@maple/web-data/alerts/form-utils"
import { Effect } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { SessionTenant } from "../../../data/session-tenant"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The alert reads and writes the hub, rule and incident pages share, as Effects their Commands wrap.

/** `alertDeliveries.list({ limit: 100 })` (optionally one incident's), as documents. */
export const listDeliveriesRaw = (incidentId?: AlertIncidentId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.alertDeliveries.list({
			query: incidentId === undefined ? { limit: 100 } : { incident_id: incidentId, limit: 100 },
		})
		return response.data.map(v2DeliveryToDocument)
	})

export const listDeliveries = (incidentId?: AlertIncidentId) =>
	listDeliveriesRaw(incidentId).pipe(Effect.mapError(toLoadFailure))

/** The session's roles allow org administration (`root` or `org:admin`). */
export const readIsAdmin = Effect.gen(function* () {
	const session = yield* (yield* SessionTenant).get
	return session.roles.some((role) => role === "root" || role === "org:admin")
}).pipe(Effect.orElseSucceed(() => false))

/** `toggleRuleHandler`: PATCH the rule's `enabled`. */
export const setRuleEnabled = (ruleId: AlertRuleId, isEnabled: boolean) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.alertRules.update({ params: { id: ruleId }, payload: { enabled: isEnabled } })
	}).pipe(Effect.mapError(toLoadFailure))

export const updateDestination = (destinationId: AlertDestinationId, payload: V2AlertDestinationUpdateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const params = { id: destinationId }
		// The client takes one request type per union member, so each narrowed payload is sent on its own.
		switch (payload.type) {
			case "pagerduty":
				return yield* client.alertDestinations.update({ params, payload })
			case "webhook":
				return yield* client.alertDestinations.update({ params, payload })
			case "hazel-oauth":
				return yield* client.alertDestinations.update({ params, payload })
			case "discord":
				return yield* client.alertDestinations.update({ params, payload })
			case "telegram":
				return yield* client.alertDestinations.update({ params, payload })
			case "email":
				return yield* client.alertDestinations.update({ params, payload })
			case "chat":
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

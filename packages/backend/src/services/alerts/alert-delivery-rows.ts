import type {
	AlertDestinationId,
	AlertEventType,
	AlertIncidentId,
	AlertRuleId,
	AlertSilenceId,
	OrgId,
} from "@maple/domain/http"
import { AlertDeliveryEventDocument } from "@maple/domain/http"
import type { AlertDeliveryEventRow, AlertIncidentRow } from "@maple/db/tables"
import { makeAlertDeliveryKey } from "@maple/alerting-core"
import { Schema } from "effect"

const decodeDeliveryEventId = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)

/** How a chat post that was deliberately not made reads in a delivery's provider message. */
export const SKIPPED_POST_PREFIX = "Skipped:"

export interface QueuedDeliveryEvent {
	readonly id: string
	readonly orgId: OrgId
	readonly incidentId: AlertIncidentId | null
	readonly ruleId: AlertRuleId
	readonly destinationId: AlertDestinationId
	readonly eventType: AlertEventType
	readonly payload: Record<string, unknown>
	readonly scheduledAt: number
	readonly deliveryKey: string
	readonly attemptNumber: number
	/** Set when a silence holds the row back: it is kept, never sent. */
	readonly status?: "queued" | "silenced"
	readonly silenceId?: AlertSilenceId | null
}

/** A delivery row waiting for the drain; every writer of the outbox builds its row here. */
export const queuedDeliveryEventRow = (event: QueuedDeliveryEvent): AlertDeliveryEventRow => ({
	id: decodeDeliveryEventId(event.id),
	orgId: event.orgId,
	incidentId: event.incidentId,
	ruleId: event.ruleId,
	destinationId: event.destinationId,
	deliveryKey: event.deliveryKey,
	eventType: event.eventType,
	attemptNumber: event.attemptNumber,
	status: event.status ?? "queued",
	silenceId: event.silenceId ?? null,
	scheduledAt: event.scheduledAt,
	claimedAt: null,
	claimExpiresAt: null,
	claimedBy: null,
	attemptedAt: null,
	providerMessage: null,
	providerReference: null,
	responseCode: null,
	errorMessage: null,
	payloadJson: event.payload,
	createdAt: event.scheduledAt,
	updatedAt: event.scheduledAt,
})

/** The `acknowledge` a pager that was paged about `incident` is sent once someone is on it. */
export const acknowledgeDeliveryEventRow = (
	incident: AlertIncidentRow,
	destinationId: AlertDestinationId,
	nowMs: number,
	id: string,
): AlertDeliveryEventRow =>
	queuedDeliveryEventRow({
		id,
		orgId: incident.orgId,
		incidentId: incident.id,
		ruleId: incident.ruleId,
		destinationId,
		eventType: "acknowledge",
		payload: {
			eventType: "acknowledge",
			incidentId: incident.id,
			incidentStatus: incident.status,
			dedupeKey: incident.dedupeKey,
			peakSeverity: incident.peakSeverity,
			rule: {
				id: incident.ruleId,
				name: incident.ruleName,
				severity: incident.severity,
				groupKey: incident.groupKey,
				signalType: incident.signalType,
			},
		},
		scheduledAt: nowMs,
		deliveryKey: makeAlertDeliveryKey(incident.id, destinationId, "acknowledge", nowMs),
		attemptNumber: 1,
	})

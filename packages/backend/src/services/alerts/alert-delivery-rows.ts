import type {
	AlertDestinationId,
	AlertEventType,
	AlertIncidentId,
	AlertRuleId,
	OrgId,
} from "@maple/domain/http"
import { AlertDeliveryEventDocument } from "@maple/domain/http"
import type { AlertDeliveryEventRow } from "@maple/db/tables"
import { Schema } from "effect"

const decodeDeliveryEventId = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)

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
	status: "queued",
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

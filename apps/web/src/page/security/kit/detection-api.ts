import type {
	AlertRuleId,
	AuditDetectionCreateRequest,
	AuditDetectionUpdateRequest,
} from "@maple/domain/http"
import { Effect } from "effect"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// The audit log detections on the api Worker. All four need `audit_log:read`: a member gets
// `audit_trail_forbidden`.

/** Every detection of the org, newest first. One read: the API caps an org at 50. */
export const listDetections = Effect.flatMap(MapleInternalApiClient, (api) => api.auditTrail.listDetections())

export const createDetection = (payload: AuditDetectionCreateRequest) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.auditTrail.createDetection({ payload }))

/** Only the fields sent change; the answer is the detection as stored. */
export const updateDetection = (id: AlertRuleId, payload: AuditDetectionUpdateRequest) =>
	Effect.flatMap(MapleInternalApiClient, (api) =>
		api.auditTrail.updateDetection({ params: { id }, payload }),
	)

/** Deletes the detection's rule, and its incidents with it. */
export const deleteDetection = (id: AlertRuleId) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.auditTrail.deleteDetection({ params: { id } }))

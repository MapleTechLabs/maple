import { Effect } from "effect"
import type { HttpServerRequest } from "effect/http"
import type { AuditLogSource, TenantContext } from "@maple/domain/http"
import { httpRequestForensics, type AuditLogServiceApi } from "@maple/backend/services/audit/AuditLogService"

/** Bound on impersonated session ids remembered per isolate. */
const MAX_TRACKED_SESSIONS = 10_000

/**
 * Impersonated sessions already recorded by this isolate. Isolates multiply and recycle, so
 * this is at most once per session per isolate: never per request, never zero.
 */
const recordedSessions = new Set<string>()

/** True the first time this isolate sees `sessionId`; marks it seen. */
const firstSighting = (sessionId: string): boolean => {
	if (recordedSessions.has(sessionId)) return false
	if (recordedSessions.size >= MAX_TRACKED_SESSIONS) {
		const oldest = recordedSessions.values().next()
		if (!oldest.done) recordedSessions.delete(oldest.value)
	}
	recordedSessions.add(sessionId)
	return true
}

/**
 * Record `auth.impersonation` the first time an impersonated session is seen. Impersonated
 * sessions may write; every one is attributed here. No span: this runs on every request.
 * Never fails, same contract as `record`.
 */
export const recordImpersonation = (
	audit: AuditLogServiceApi,
	request: HttpServerRequest.HttpServerRequest,
	tenant: TenantContext,
	source: AuditLogSource,
): Effect.Effect<void> => {
	const impersonation = tenant.impersonation
	if (
		impersonation === undefined ||
		// No session id to key on: record every request rather than fold distinct sessions together.
		(impersonation.sessionId !== "unknown" &&
			!firstSighting(`${tenant.orgId}|${impersonation.actorId}|${impersonation.sessionId}`))
	) {
		return Effect.void
	}
	return audit.record({
		orgId: tenant.orgId,
		actor: { type: "user", userId: tenant.userId },
		source,
		action: "auth.impersonation",
		affectedUserId: tenant.userId,
		metadata: { impersonatorId: impersonation.actorId, sessionId: impersonation.sessionId },
		...httpRequestForensics(request),
	})
}

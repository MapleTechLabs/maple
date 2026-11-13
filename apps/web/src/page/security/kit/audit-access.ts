import * as Policy from "@maple/domain/policy"

// Who may read the audit trail and its detections: org admins (`audit_log:read`).

type SessionAnswer = Readonly<{
	grants: ReadonlyArray<Policy.Permission>
	/** False until the session answers: a page says nothing about access before it knows. */
	isGrantsRead: boolean
}>

/**
 * What the session says: `denied` only when it answered and the permission is missing. A session
 * that answered with nothing failed to read, so the API is asked and gets the last word.
 */
export const auditAccessOf = (model: SessionAnswer): "unknown" | "ask" | "denied" =>
	!model.isGrantsRead
		? "unknown"
		: model.grants.length === 0 || Policy.has(model.grants, "audit_log:read")
			? "ask"
			: "denied"

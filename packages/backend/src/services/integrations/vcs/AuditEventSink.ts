import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import type { AuditTrailPersistenceError } from "@maple/domain/http"
import type { OrgId } from "@maple/primitives"
import { Context, type Effect } from "effect"

/**
 * Where a provider's audit event goes once the VCS layer has resolved its org. Optional in
 * `VcsSyncService`, like the other sinks: a root without it drops the event. Unlike them it fails:
 * an audit event lost to a failed write is a gap in the record, so the job retries.
 */
export interface AuditEventSinkApi {
	readonly onAuditEvent: (
		orgId: OrgId,
		event: AuditTrailEvent,
	) => Effect.Effect<void, AuditTrailPersistenceError>
}

export class AuditEventSink extends Context.Service<AuditEventSink, AuditEventSinkApi>()(
	"@maple/backend/services/integrations/vcs/AuditEventSink",
) {}

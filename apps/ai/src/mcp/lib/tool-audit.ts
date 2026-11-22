/**
 * What a tool needs to write an audit entry under the same action its REST route writes, so a
 * source paused by an agent reads in the audit log like one paused in the dashboard.
 */
import { Effect } from "effect"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { auditAttribution, originMetadata } from "@maple/backend/services/audit/audit-access"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { CurrentMcpTenant } from "../tenant"

/** The audit log, who is acting, and the chat origin to merge into an entry's metadata. */
export const toolAudit = Effect.gen(function* () {
	const tenant = yield* CurrentMcpTenant
	const audit = yield* AuditLogService
	const actor = yield* CurrentAuditActor
	return {
		record: audit.record,
		who: { orgId: tenant.orgId, ...auditAttribution(tenant, actor) },
		origin: originMetadata(tenant.turnOrigin),
	}
})

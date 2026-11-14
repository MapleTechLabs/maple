/**
 * The tenant a scheduled job, signed link or other viewer-less read acts as, `root`-roled.
 * It grants nothing on its own: every query still filters `OrgId`, and the org comes from the
 * row or the signed claims, never from the caller. `userId` names the job for attribution.
 */
import { RoleName, UserId, type OrgId, type TenantContext } from "@maple/domain/http"

const SYSTEM_ROLES = [RoleName.make("root")]

/** The attribution id the alerting jobs (and the readers that borrowed their tenant) use. */
export const ALERTING_SYSTEM_USER_ID = UserId.make("system-alerting")

export const systemTenant = (orgId: OrgId, userId: UserId): TenantContext => ({
	orgId,
	userId,
	roles: SYSTEM_ROLES,
	authMode: "self_hosted",
})

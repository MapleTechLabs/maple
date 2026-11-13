// The handler bodies every pasted-credential cost source shares (`cost_connections`): the role
// check, the provider's own save or remove, and its audit record.
import {
	CostConnectionForbiddenError,
	CostConnectionRemoved,
	CostConnectionSaved,
	CurrentTenant,
} from "@maple/domain/http"
import type { CostProvider } from "@maple/domain/cost"
import type { OrgId, UserId } from "@maple/primitives"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new CostConnectionForbiddenError({ message: denial.message }),
	)

/** Saves the org's credential for `provider` with `save`, which checks it with the vendor first. */
export const saveCostConnection = <E, R>(
	provider: CostProvider,
	save: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<{ readonly accountId: string; readonly accountLabel: string }, E, R>,
) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentTenant.Context
		yield* requireIntegrationsManager(tenant.roles)
		const saved = yield* save(tenant.orgId, tenant.userId)
		yield* recordHttpAudit("cost_source_key.updated", {
			metadata: { provider, accountId: saved.accountId },
		})
		return new CostConnectionSaved(saved)
	})

/** Removes the org's credential for `provider`, and with it the cost source. */
export const removeCostConnection = <E, R>(
	provider: CostProvider,
	remove: (orgId: OrgId) => Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentTenant.Context
		yield* requireIntegrationsManager(tenant.roles)
		yield* remove(tenant.orgId)
		yield* recordHttpAudit("cost_source_key.deleted", { metadata: { provider } })
		return new CostConnectionRemoved({ removed: true })
	})

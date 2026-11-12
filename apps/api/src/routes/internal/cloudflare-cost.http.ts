import { HttpApiBuilder } from "effect/http-api"
import {
	CostConnectionForbiddenError,
	CostConnectionRemoved,
	CostConnectionSaved,
	CurrentTenant,
	MapleInternalApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { CloudflareCostConnectionService } from "@maple/backend/services/cost/CloudflareCostConnectionService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new CostConnectionForbiddenError({ message: denial.message }),
	)

export const HttpCloudflareCostLive = HttpApiBuilder.group(MapleInternalApi, "cloudflareCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* CloudflareCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const saved = yield* connections.set(tenant.orgId, tenant.userId, payload.apiToken)
					yield* recordHttpAudit("cost_source_key.updated", {
						metadata: { provider: "cloudflare", accountId: saved.accountId },
					})
					return new CostConnectionSaved(saved)
				}).pipe(Effect.withSpan("HttpCloudflareCost.set")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					yield* connections.remove(tenant.orgId)
					yield* recordHttpAudit("cost_source_key.deleted", {
						metadata: { provider: "cloudflare" },
					})
					return new CostConnectionRemoved({ removed: true })
				}).pipe(Effect.withSpan("HttpCloudflareCost.remove")),
			)
	}),
)

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
import { AnthropicCostConnectionService } from "@maple/backend/services/cost/AnthropicCostConnectionService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new CostConnectionForbiddenError({ message: denial.message }),
	)

export const HttpAnthropicCostLive = HttpApiBuilder.group(MapleInternalApi, "anthropicCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* AnthropicCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const saved = yield* connections.set(tenant.orgId, tenant.userId, payload.apiKey)
					yield* recordHttpAudit("cost_source_key.updated", {
						metadata: { provider: "anthropic", accountId: saved.accountId },
					})
					return new CostConnectionSaved(saved)
				}).pipe(Effect.withSpan("HttpAnthropicCost.set")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					yield* connections.remove(tenant.orgId)
					yield* recordHttpAudit("cost_source_key.deleted", {
						metadata: { provider: "anthropic" },
					})
					return new CostConnectionRemoved({ removed: true })
				}).pipe(Effect.withSpan("HttpAnthropicCost.remove")),
			)
	}),
)

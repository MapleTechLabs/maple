import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	MapleInternalApi,
	OpenRouterCostKeyRemoved,
	OpenRouterCostKeySaved,
	OpenRouterKeyForbiddenError,
} from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OpenRouterCostConnectionService } from "@maple/backend/services/cost/OpenRouterCostConnectionService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (permissions: CurrentTenant.TenantSchema["permissions"]) =>
	Policy.check(
		permissions,
		"integrations:manage",
		(denial) => new OpenRouterKeyForbiddenError({ message: denial.message }),
	)

export const HttpOpenRouterCostLive = HttpApiBuilder.group(MapleInternalApi, "openRouterCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* OpenRouterCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.permissions)
					const saved = yield* connections.set(tenant.orgId, tenant.userId, payload.apiKey)
					yield* recordHttpAudit("cost_source_key.updated", {
						metadata: { provider: "openrouter", keyLabel: saved.keyLabel },
					})
					return new OpenRouterCostKeySaved(saved)
				}).pipe(Effect.withSpan("HttpOpenRouterCost.set")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.permissions)
					yield* connections.remove(tenant.orgId)
					yield* recordHttpAudit("cost_source_key.deleted", {
						metadata: { provider: "openrouter" },
					})
					return new OpenRouterCostKeyRemoved({ removed: true })
				}).pipe(Effect.withSpan("HttpOpenRouterCost.remove")),
			)
	}),
)

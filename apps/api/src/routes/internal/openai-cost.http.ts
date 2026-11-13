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
import { OpenAiCostConnectionService } from "@maple/backend/services/cost/OpenAiCostConnectionService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new CostConnectionForbiddenError({ message: denial.message }),
	)

export const HttpOpenAiCostLive = HttpApiBuilder.group(MapleInternalApi, "openaiCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* OpenAiCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const saved = yield* connections.set(tenant.orgId, tenant.userId, payload.apiKey)
					yield* recordHttpAudit("cost_source_key.updated", {
						metadata: { provider: "openai", accountId: saved.accountId },
					})
					return new CostConnectionSaved(saved)
				}).pipe(Effect.withSpan("HttpOpenAiCost.set")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					yield* connections.remove(tenant.orgId)
					yield* recordHttpAudit("cost_source_key.deleted", {
						metadata: { provider: "openai" },
					})
					return new CostConnectionRemoved({ removed: true })
				}).pipe(Effect.withSpan("HttpOpenAiCost.remove")),
			)
	}),
)

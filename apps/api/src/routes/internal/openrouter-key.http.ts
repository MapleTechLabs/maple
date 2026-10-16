import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi, OpenRouterKeyForbiddenError } from "@maple/domain/http"
import { Effect } from "effect"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OrgOpenRouterKeyService } from "@maple/backend/services/org/OrgOpenRouterKeyService"

const requireKeyAdmin = (roles: CurrentTenant.TenantSchema["roles"]) =>
	requireAdmin(
		roles,
		() => new OpenRouterKeyForbiddenError({ message: "Only org admins can manage the OpenRouter key" }),
	)

export const HttpOpenRouterKeyLive = HttpApiBuilder.group(MapleInternalApi, "openRouterKey", (handlers) =>
	Effect.gen(function* () {
		const keys = yield* OrgOpenRouterKeyService

		return handlers
			.handle("get", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* keys.get(tenant.orgId)
				}).pipe(Effect.withSpan("HttpOpenRouterKey.get")),
			)
			.handle("set", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireKeyAdmin(tenant.roles)
					const document = yield* keys.set(tenant.orgId, tenant.userId, payload.apiKey)
					yield* recordHttpAudit("ai_provider_key.updated", {
						metadata: { provider: "openrouter", keyHint: document.keyHint },
					})
					return document
				}).pipe(Effect.withSpan("HttpOpenRouterKey.set")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireKeyAdmin(tenant.roles)
					const document = yield* keys.remove(tenant.orgId)
					yield* recordHttpAudit("ai_provider_key.deleted", {
						metadata: { provider: "openrouter" },
					})
					return document
				}).pipe(Effect.withSpan("HttpOpenRouterKey.remove")),
			)
	}),
)

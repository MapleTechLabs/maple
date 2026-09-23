import { HttpServerRequest } from "effect/unstable/http"
import { API_KEY_PREFIX } from "@maple/db"
import { CurrentTenant } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { makeResolveTenant } from "./AuthService"
import { annotateAuthSpan } from "@maple/backend/services/auth/auth-span"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { withAuditedRead } from "@maple/backend/services/audit/audit-access"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"

const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
	return token
}

/**
 * Authorization for the internal API: Clerk sessions only.
 *
 * The public `ApiAuthorizationLayer` tries an API key first and falls back to a
 * session. This one inverts the posture — an API-key-shaped token is refused
 * outright, because these endpoints are dashboard transport whose request and
 * response shapes change with the UI.
 *
 * The refusal is a prefix test, not a lookup: `API_KEY_PREFIX` identifies the
 * credential without consulting Postgres, so a rejected key costs no database
 * dial on what is the busiest path in the API. Session tokens never match the
 * prefix, so they reach `resolveTenant` exactly as before.
 */
export const SessionAuthorizationLayer = Layer.effect(
	CurrentTenant.SessionAuthorization,
	Effect.gen(function* () {
		const env = yield* Env
		const audit = yield* AuditLogService
		const regions = yield* OrganizationRegionService
		const resolveTenant = makeResolveTenant(env)

		return CurrentTenant.SessionAuthorization.of({
			bearer: (httpEffect, options) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest

					const token = getBearerToken(request.headers)
					if (token?.startsWith(API_KEY_PREFIX)) {
						return yield* new CurrentTenant.ApiKeyNotAcceptedError({
							message: "API keys cannot call the internal API; use the /v2 API instead",
						})
					}

					const tenant = yield* resolveTenant(request.headers)
					yield* annotateAuthSpan("session", { orgId: tenant.orgId, userId: tenant.userId })
					yield* regions.ensureServedHere(tenant.orgId)
					const actor = { type: "user", source: "dashboard" } as const
					return yield* httpEffect.pipe(
						Effect.provideService(CurrentTenant.Context, new CurrentTenant.TenantSchema(tenant)),
						Effect.provideService(CurrentAuditActor, actor),
						// Telemetry and replay reads are recorded (see `AuditedRead`).
						withAuditedRead(audit, request, options, {
							orgId: tenant.orgId,
							actor: { type: "user", userId: tenant.userId },
							source: actor.source,
						}),
					)
				}),
		})
	}),
)

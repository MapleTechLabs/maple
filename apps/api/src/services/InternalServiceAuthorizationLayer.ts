import { HttpServerRequest } from "effect/unstable/http"
import { CurrentTenant, UnauthorizedError } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { resolveMcpTenantContext } from "../mcp/lib/resolve-tenant"
import { AuthService } from "./AuthService"
import { ApiKeysService } from "./ApiKeysService"
import { Env } from "../lib/Env"

const messageOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: "Unauthorized"

/**
 * Implementation of the {@link CurrentTenant.InternalServiceAuthorization}
 * middleware — the server-to-server counterpart of {@link ApiAuthorizationLayer}.
 *
 * Resolves the tenant from the internal-service bearer token (+ `x-org-id`) via
 * the same {@link resolveMcpTenantContext} the MCP server uses, then provides the
 * shared {@link CurrentTenant.Context} so internal HttpApi handlers read the org
 * exactly like the Clerk-authed ones. Any resolution failure becomes a declared
 * `UnauthorizedError` (→ 401), so the route never maps errors by hand.
 */
export const InternalServiceAuthorizationLayer = Layer.effect(
	CurrentTenant.InternalServiceAuthorization,
	Effect.gen(function* () {
		const env = yield* Env
		const apiKeys = yield* ApiKeysService
		const auth = yield* AuthService

		return CurrentTenant.InternalServiceAuthorization.of({
			bearer: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
						Effect.mapError(() => new UnauthorizedError({ message: "Failed to read request" })),
					)

					const tenant = yield* Effect.provideService(
						Effect.provideService(
							Effect.provideService(resolveMcpTenantContext(webRequest), Env, env),
							ApiKeysService,
							apiKeys,
						),
						AuthService,
						auth,
					).pipe(Effect.mapError((error) => new UnauthorizedError({ message: messageOf(error) })))

					return yield* Effect.provideService(
						httpEffect,
						CurrentTenant.Context,
						new CurrentTenant.TenantSchema({
							orgId: tenant.orgId,
							userId: tenant.userId,
							roles: tenant.roles,
							authMode: tenant.authMode,
						}),
					)
				}),
		})
	}),
)

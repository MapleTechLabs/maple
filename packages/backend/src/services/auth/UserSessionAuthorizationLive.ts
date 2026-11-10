import { HttpServerRequest } from "effect/http"
import { API_KEY_PREFIX } from "@maple/db"
import { makeResolveClerkUser } from "@maple/auth"
import { CurrentTenant } from "@maple/domain/http"
import { Effect, Layer, String as Str } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { getBearerToken } from "./bearer-token"

/**
 * Authorization for the few requests made before the caller has an organization. A Clerk session
 * alone; an API key belongs to an organization and is refused, as on every session-only route.
 */
export const UserSessionAuthorizationLive = Layer.effect(
	CurrentTenant.UserSessionAuthorization,
	Effect.gen(function* () {
		const env = yield* Env
		const resolveUser = makeResolveClerkUser(env)

		return CurrentTenant.UserSessionAuthorization.of({
			bearer: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					if (Str.startsWith(API_KEY_PREFIX)(getBearerToken(request.headers) ?? "")) {
						return yield* new CurrentTenant.ApiKeyNotAcceptedError({
							message: "API keys cannot call the internal API; use the /v2 API instead",
						})
					}
					const userId = yield* resolveUser(request.headers)
					yield* Effect.annotateCurrentSpan({
						"maple.auth.method": "session",
						"tenant.userId": userId,
					})
					return yield* httpEffect.pipe(
						Effect.provideService(CurrentTenant.CurrentUser, { userId }),
					)
				}),
		})
	}),
)

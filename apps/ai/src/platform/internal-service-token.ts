import { secretsEqual } from "@maple/backend/services/auth/secret-equal"
import { Env } from "@maple/backend/platform/Env"
import { INTERNAL_SERVICE_BEARER_PREFIX } from "@maple/domain/http"
import { Effect, Option, Redacted, String as Str } from "effect"

/** How a `maple_svc_<token>` compares with this Worker's configured `INTERNAL_SERVICE_TOKEN`. */
export type InternalServiceTokenCheck = "accepted" | "rejected" | "unconfigured"

/** Constant-time check of a `maple_svc_<token>` bearer token. A blank configured token is none. */
export const checkInternalServiceToken = (
	token: string,
	configured: Option.Option<Redacted.Redacted>,
): InternalServiceTokenCheck => {
	const expected = Option.getOrElse(Option.map(configured, Redacted.value), () => "")
	if (expected === "") return "unconfigured"
	return Str.startsWith(INTERNAL_SERVICE_BEARER_PREFIX)(token) &&
		secretsEqual(Str.slice(INTERNAL_SERVICE_BEARER_PREFIX.length)(token), expected)
		? "accepted"
		: "rejected"
}

/**
 * Admit only `Authorization: Bearer maple_svc_<INTERNAL_SERVICE_TOKEN>`, for the internal routes
 * reached over a service binding; `refuse` builds the route's own unauthorized error.
 */
export const requireInternalServiceBearer = Effect.fn("InternalServiceToken.require")(function* <E>(
	authorization: string,
	refuse: (message: string) => E,
) {
	const env = yield* Env
	const [scheme, token] = Str.split(" ")(authorization)
	const bearer = scheme !== undefined && Str.toLowerCase(scheme) === "bearer" ? (token ?? "") : ""
	const check = checkInternalServiceToken(bearer, env.INTERNAL_SERVICE_TOKEN)
	if (check === "unconfigured") {
		return yield* Effect.fail(refuse("INTERNAL_SERVICE_TOKEN is not configured on maple-ai"))
	}
	if (check === "rejected") return yield* Effect.fail(refuse("internal service token rejected"))
})

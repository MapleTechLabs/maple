import { secretsEqual } from "@maple/backend/services/auth/secret-equal"
import { INTERNAL_SERVICE_BEARER_PREFIX } from "@maple/domain/http"
import { String as Str } from "effect"

/**
 * Constant-time check of `Authorization: Bearer maple_svc_<token>` against the
 * configured `INTERNAL_SERVICE_TOKEN`; the same check `resolveMcpTenantContext`
 * makes for the chat agent.
 */
export const isValidServiceBearer = (authorization: string, expected: string): boolean => {
	const [scheme, token] = Str.split(" ")(authorization)
	if (!scheme || !token || Str.toLowerCase(scheme) !== "bearer") return false
	if (!Str.startsWith(INTERNAL_SERVICE_BEARER_PREFIX)(token)) return false
	return secretsEqual(Str.slice(INTERNAL_SERVICE_BEARER_PREFIX.length)(token), expected)
}

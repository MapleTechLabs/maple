import { timingSafeEqual } from "node:crypto"
import { INTERNAL_SERVICE_BEARER_PREFIX } from "@maple/domain/http"

/**
 * Constant-time check of `Authorization: Bearer maple_svc_<token>` against the
 * configured `INTERNAL_SERVICE_TOKEN`; the same check `resolveMcpTenantContext`
 * makes for the chat agent. Compares UTF-8 bytes, because `timingSafeEqual`
 * throws on unequal buffer lengths.
 */
export const isValidServiceBearer = (authorization: string, expected: string): boolean => {
	const [scheme, token] = authorization.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return false
	if (!token.startsWith(INTERNAL_SERVICE_BEARER_PREFIX)) return false
	const provided = Buffer.from(token.slice(INTERNAL_SERVICE_BEARER_PREFIX.length), "utf8")
	const wanted = Buffer.from(expected, "utf8")
	return provided.length === wanted.length && timingSafeEqual(provided, wanted)
}

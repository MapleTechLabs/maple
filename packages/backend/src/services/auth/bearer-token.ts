import { RoleName } from "@maple/domain/http"
import { String as Str } from "effect"

/** The token of an `Authorization: Bearer <token>` header, or undefined for any other shape. */
export const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = Str.split(" ")(header)
	if (!scheme || !token || Str.toLowerCase(scheme) !== "bearer") return undefined
	return token
}

/** The roles an API key acts with when it was minted without any. */
export const API_KEY_DEFAULT_ROLES = [RoleName.make("root")] as const

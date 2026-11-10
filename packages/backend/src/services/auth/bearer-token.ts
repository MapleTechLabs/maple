import { String as Str } from "effect"

/** The token of an `Authorization: Bearer <token>` header; undefined for any other shape. */
export const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = Str.split(" ")(header)
	if (!scheme || !token || Str.toLowerCase(scheme) !== "bearer") return undefined
	return token
}

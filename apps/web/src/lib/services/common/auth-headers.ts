import * as Predicate from "effect/Predicate"

const decodeBase64Url = (segment: string): string => {
	const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
	return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="))
}

/** Expiry of a JWT in epoch ms, or undefined if the token isn't one we can read. */
export const readJwtExpMs = (token: string): number | undefined => {
	const segments = token.split(".")
	if (segments.length !== 3 || segments[1] === undefined) return undefined
	try {
		const claims: unknown = JSON.parse(decodeBase64Url(segments[1]))
		if (!Predicate.isObject(claims)) return undefined
		const exp = claims.exp
		return Predicate.isNumber(exp) && Number.isFinite(exp) ? exp * 1000 : undefined
	} catch {
		// Not a JWT we can read: the caller treats the token as having no deadline.
		return undefined
	}
}

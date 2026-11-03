import { Option, Schema, String as Str } from "effect"
import * as Predicate from "effect/Predicate"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const decodeBase64Url = (segment: string): string => {
	const padded = Str.replace(/_/g, "/")(Str.replace(/-/g, "+")(segment))
	return atob(Str.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=")(padded))
}

/** Expiry of a JWT in epoch ms, or undefined if the token isn't one we can read. */
export const readJwtExpMs = (token: string): number | undefined => {
	const segments = Str.split(".")(token)
	if (segments.length !== 3 || segments[1] === undefined) return undefined
	try {
		const claims = Option.getOrUndefined(decodeJson(decodeBase64Url(segments[1])))
		if (!Predicate.isObject(claims)) return undefined
		const exp = claims.exp
		return Predicate.isNumber(exp) && Number.isFinite(exp) ? exp * 1000 : undefined
	} catch {
		// Not a JWT we can read: the caller treats the token as having no deadline.
		return undefined
	}
}

import { timingSafeEqual } from "node:crypto"
import { String as Str } from "effect"

/**
 * Timing-safe check of an `Authorization: Bearer <token>` header against the
 * shared internal token (`SD_INTERNAL_TOKEN`). Used by the internal scraper
 * endpoints; never configured ⇒ always unauthorized.
 */
export const isValidInternalBearer = (
	authorizationHeader: string | undefined,
	internalToken: string | undefined,
): boolean => {
	if (!internalToken) return false
	const provided = authorizationHeader?.startsWith("Bearer ")
		? Str.trim(Str.slice(7)(authorizationHeader))
		: ""
	return (
		provided.length === internalToken.length &&
		timingSafeEqual(Buffer.from(provided), Buffer.from(internalToken))
	)
}

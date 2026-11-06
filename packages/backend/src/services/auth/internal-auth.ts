import { String as Str } from "effect"
import { secretsEqual } from "./secret-equal"

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
	if (authorizationHeader === undefined || !Str.startsWith("Bearer ")(authorizationHeader)) return false
	return secretsEqual(Str.trim(Str.slice(7)(authorizationHeader)), internalToken)
}

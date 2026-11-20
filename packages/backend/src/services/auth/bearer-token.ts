import { RoleName } from "@maple/domain/http"
import { Array as Arr, Result, String as Str } from "effect"
import * as Base64 from "effect/encoding/Base64"

/** The token of an `Authorization: Bearer <token>` header, or undefined for any other shape. */
export const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = Str.split(/ +/)(header)
	if (!scheme || !token || Str.toLowerCase(scheme) !== "bearer") return undefined
	return token
}

/**
 * The password of an `Authorization: Basic base64(user:password)` header (RFC 7617), the username
 * ignored. Undefined for any other scheme; a failure when the credentials do not decode.
 */
export const getBasicPassword = (
	headers: Record<string, string | undefined>,
): Result.Result<string, "malformed"> | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, encoded] = Str.split(/ +/)(header)
	if (!scheme || Str.toLowerCase(scheme) !== "basic") return undefined
	const decoded = encoded === undefined ? Result.fail(undefined) : Base64.decodeString(encoded)
	if (Result.isFailure(decoded)) return Result.fail("malformed")
	// RFC 7617: the user id ends at the first colon; the password may hold more.
	const [, ...rest] = Str.split(":")(decoded.success)
	const password = Arr.join(rest, ":")
	return password.length > 0 ? Result.succeed(password) : Result.fail("malformed")
}

/** The roles an API key acts with when it was minted without any. */
export const API_KEY_DEFAULT_ROLES = [RoleName.make("root")] as const

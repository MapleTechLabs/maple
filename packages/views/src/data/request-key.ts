import { encodeOrgScopedKey } from "@maple/web-data/lib/cache-key"
import { Option, Schema, String as Str } from "effect"

/**
 * The identity of one data request: org, operation and input
 * (`encodeOrgScopedKey`: org, NUL, the sorted and 15 s-snapped input). A result Message carries the
 * key it was requested under; `update` drops it unless it still matches the slot, so a slow
 * answer for an old filter, window or org never lands.
 */
export type RequestKey = string

export const requestKey = (orgId: string, operation: string, input: unknown): RequestKey =>
	encodeOrgScopedKey(orgId, { operation, input })

/** The org a key was built for, so an org switch can drop data instead of keeping it on screen. */
export const orgOfKey = (key: RequestKey): string =>
	Str.slice(
		0,
		Option.getOrElse(Str.indexOf("\u0000")(key), () => -1),
	)(key)

/** Any value as JSON text: the stable string a key, a cache id or an equality check compares. */
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

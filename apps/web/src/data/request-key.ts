import { encodeOrgScopedKey } from "@maple/web-data/lib/cache-key"

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
export const orgOfKey = (key: RequestKey): string => key.slice(0, key.indexOf("\u0000"))

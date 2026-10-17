/**
 * The identity of one data request: org, operation and input, encoded like apps/web's
 * `encodeOrgScopedKey` (`src/lib/cache-key.ts`): sorted keys, `undefined` dropped, NUL-separated.
 * A result Message carries the key it was requested under; `update` drops it unless it still
 * matches the slot, so a slow answer for an old filter, window or org never lands.
 */
export type RequestKey = string

const SEPARATOR = "\u0000"

/** `JSON.stringify` with object keys sorted and `undefined` fields dropped (`encodeKey`). */
const encode = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
	const fields = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`)
	return `{${fields.join(",")}}`
}

export const requestKey = (orgId: string, operation: string, input: unknown): RequestKey =>
	[orgId, operation, encode(input)].join(SEPARATOR)

/** The org a key was built for, so an org switch can drop data instead of keeping it on screen. */
export const orgOfKey = (key: RequestKey): string => key.slice(0, key.indexOf(SEPARATOR))

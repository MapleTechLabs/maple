/**
 * A loosely typed row cell as text. Scalars print as themselves; null, undefined and anything
 * structured take the fallback rather than printing `[object Object]`.
 */
export const rowText = (value: unknown, fallback = ""): string => {
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
		return value.toString()
	return fallback
}

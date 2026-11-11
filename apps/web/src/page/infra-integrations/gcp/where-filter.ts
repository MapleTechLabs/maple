import { String as Str } from "effect"
// The where-clause helpers of the metric breakdown, pure so other surfaces can share them.

function quoteFilterValue(value: string): string {
	return `"${Str.replaceAll('"', '\\"')(value)}"`
}

/**
 * Adds `key = "value"` to a where clause. An existing clause for the same key
 * is replaced instead of appended — the metrics path honors only a single
 * attr.* equality filter, so stacking two would silently drop the second.
 */
export function appendWhereFilter(where: string, key: string, value: string): string {
	const clause = `${key} = ${quoteFilterValue(value)}`
	const trimmed = Str.trim(where)
	if (!trimmed) return clause

	const escapedKey = Str.replaceAll(".", "\\.")(key)
	const sameKeyClause = new RegExp(`${escapedKey}\\s*=\\s*"(?:[^"\\\\]|\\\\.)*"`)
	if (sameKeyClause.test(trimmed)) {
		return Str.replace(sameKeyClause, clause)(trimmed)
	}

	return `${trimmed} AND ${clause}`
}

// The where-clause helpers of the metric breakdown, pure so other surfaces can share them.

function quoteFilterValue(value: string): string {
	return `"${value.replaceAll('"', '\\"')}"`
}

/**
 * Adds `key = "value"` to a where clause. An existing clause for the same key
 * is replaced instead of appended — the metrics path honors only a single
 * attr.* equality filter, so stacking two would silently drop the second.
 */
export function appendWhereFilter(where: string, key: string, value: string): string {
	const clause = `${key} = ${quoteFilterValue(value)}`
	const trimmed = where.trim()
	if (!trimmed) return clause

	const escapedKey = key.replaceAll(".", "\\.")
	const sameKeyClause = new RegExp(`${escapedKey}\\s*=\\s*"(?:[^"\\\\]|\\\\.)*"`)
	if (sameKeyClause.test(trimmed)) {
		return trimmed.replace(sameKeyClause, clause)
	}

	return `${trimmed} AND ${clause}`
}

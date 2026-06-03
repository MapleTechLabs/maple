/**
 * Cap traced SQL at 16 KB. OTel's default attribute size limit is 32 KB, and
 * 16 KB covers the overwhelming majority of compiled DSL queries while leaving
 * headroom for other span attributes. Logs use a tighter cap.
 */
export const SQL_TRACE_MAX = 16_384
export const SQL_LOG_MAX = 1_000

export const truncateSql = (s: string, maxLen: number) =>
	s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

/**
 * Stable 32-bit FNV-1a hash over SQL with literals and numbers normalized. Lets
 * the same query with different params group together in trace search.
 */
export const fingerprintSql = (s: string): string => {
	const normalized = s.replace(/'[^']*'/g, "'?'").replace(/\b\d+\b/g, "?")
	let h = 0x811c9dc5
	for (let i = 0; i < normalized.length; i++) {
		h ^= normalized.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * The official ClickHouse client rejects a trailing `FORMAT JSONEachRow`/`FORMAT
 * JSON` (it sets the format itself) and a trailing `;`. Strip both before
 * handing the SQL to the CH driver. Tinybird's `/v0/sql` keeps the SQL as-is.
 */
export const normalizeSqlForClickHouseClient = (sql: string): string =>
	sql
		.replace(/;\s*$/, "")
		.replace(/\s+FORMAT\s+(?:JSONEachRow|JSON)\s*$/i, "")
		.replace(/;\s*$/, "")

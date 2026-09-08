export const fingerprintSql = (s: string): string => {
	const normalized = s.replace(/'[^']*'/g, "'?'").replace(/\b\d+\b/g, "?")
	let h = 0x811c9dc5
	for (let i = 0; i < normalized.length; i++) {
		h ^= normalized.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, "0")
}

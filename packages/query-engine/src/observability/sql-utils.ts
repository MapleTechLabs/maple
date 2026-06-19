/**
 * Coerce an untrusted numeric value into a safe non-negative integer for direct
 * interpolation into SQL (LIMIT / OFFSET / duration bounds). Non-finite or
 * negative inputs collapse to `fallback`; everything is truncated and clamped
 * to `[0, max]` so a hostile or malformed value can never inject SQL or blow
 * past the cap.
 */
export function safeUInt(value: number | undefined, fallback: number, max: number): number {
	if (value == null || !Number.isFinite(value)) return fallback
	const truncated = Math.trunc(value)
	if (truncated < 0) return 0
	return Math.min(truncated, max)
}

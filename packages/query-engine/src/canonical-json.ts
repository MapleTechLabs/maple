// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
/**
 * Deterministic stringification for cache keys.
 *
 * Every cache key that embeds a query object has to survive the same hazard:
 * two semantically identical `QuerySpec`s built by different producers (the
 * dashboard builder, a saved template, the MCP widget tools, alerting) carry
 * their keys in different insertion order, and `JSON.stringify` preserves that
 * order. Hashing the raw output therefore mints a fresh cache entry for a query
 * the cache already holds — a silent, unattributable hit-rate loss.
 *
 * Lives at the package root rather than inside `caching/` so the `runtime`
 * key builders can share it without `runtime` depending on `caching`. Pure —
 * safe for the driver-free root barrel.
 */

import { Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"

const encodeJsonOption = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))

/**
 * Recursively sort object keys and drop `undefined`. Arrays preserve order —
 * element order is meaningful in a `QuerySpec` (an ORDER BY list is not a set),
 * so callers that know a given field is set-like must normalize it themselves.
 * Non-serializable values are coerced with `String(...)`; cycles collapse to
 * `null` so a malformed input can never hang the key path.
 */
export const canonicalJSON = (value: unknown): string => {
	const seen = new WeakSet<object>()
	const walk = (v: unknown): unknown => {
		if (v === null) return null
		if (v === undefined) return undefined
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v
		if (typeof v === "bigint") return v.toString()
		if (Arr.isArray(v)) {
			return Arr.map(v, (item) => walk(item))
		}
		if (typeof v === "object") {
			if (seen.has(v)) return null
			seen.add(v)
			const entries = Arr.map(
				Arr.filter(Rec.toEntries(v), ([, nested]) => nested !== undefined),
				([key, nested]) => [key, walk(nested)] as const,
			).sort(([a], [b]) => Str.localeCompare(b)(a))
			return Rec.fromEntries(entries)
		}
		// symbol or function: every other type returned above.
		return typeof v === "symbol" || typeof v === "function" ? v.toString() : null
	}
	// Only a top-level `undefined` has no JSON form; it keys as `null`.
	return Option.getOrElse(encodeJsonOption(walk(value)), () => "null")
}

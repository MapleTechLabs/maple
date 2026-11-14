// Property coercion for `track()`, shared by the browser sink and the server
// SDK's product-events client. Pure: no browser globals, so it can be bundled
// into a Node entrypoint without dragging the session engine along.

import { truncateText } from "../platform/text"

/** Properties a host app may attach to a custom event. */
export type TrackProps = Readonly<Record<string, unknown>>

/**
 * Caps mirroring what the ingest gateway enforces. Applying them here too means
 * an over-sized event is trimmed before it costs bandwidth, and the developer
 * sees the same shape locally that the warehouse will store.
 */
export const MAX_EVENT_NAME_LENGTH = 128
const MAX_PROPS = 32
const MAX_PROP_KEY_LENGTH = 64
const MAX_PROP_VALUE_LENGTH = 1024
const MAX_TOTAL_PROP_BYTES = 8 * 1024

/** A surrogate pair, or a lone half of one. No lookbehind: older Safari cannot parse it. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g

/**
 * `text` with every lone surrogate replaced by U+FFFD. Strict JSON parsers
 * (ingest's among them) reject the escape for one, and the whole batch with it.
 */
export function wellFormed(text: string): string {
	return text.replace(SURROGATES, (match) => (match.length === 2 ? match : "\uFFFD"))
}

/** Cut to `max` UTF-16 units, never leaving half a surrogate pair behind. */
export function capText(text: string, max: number): string {
	return wellFormed(truncateText(text, max))
}

/**
 * Coerce one property value to the string the warehouse column holds.
 *
 * `null`/`undefined`/functions/symbols are dropped rather than stringified:
 * `"undefined"` as a stored value is worse than an absent key.
 */
function coerce(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined
	switch (typeof value) {
		case "string":
			return capText(value, MAX_PROP_VALUE_LENGTH)
		case "number":
		case "boolean":
		case "bigint":
			return String(value)
		case "function":
		case "symbol":
			return undefined
		default:
			break
	}
	try {
		if (value instanceof Date) return value.toISOString()
		const json = JSON.stringify(value)
		return json === undefined ? undefined : capText(json, MAX_PROP_VALUE_LENGTH)
	} catch {
		// Circular structure, BigInt inside, invalid Date, throwing getter or Proxy
		// trap: drop the key rather than throw into the caller.
		return undefined
	}
}

/**
 * Whether `value` is a property bag. Arrays and primitives are not: a string
 * would otherwise become `{0: "h", 1: "i"}`. `Array.isArray` throws on a
 * revoked Proxy, hence the guard.
 */
export function isPropertyBag(value: unknown): value is Readonly<Record<string, unknown>> {
	try {
		return typeof value === "object" && value !== null && !Array.isArray(value)
	} catch {
		return false
	}
}

/** Own enumerable string keys of `bag`, or none when a Proxy's `ownKeys` trap throws. */
export function bagKeys(bag: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
	try {
		return Object.keys(bag)
	} catch {
		return []
	}
}

/**
 * `parse(bag[key])`, or `undefined` when the getter (or Proxy `get` trap) throws.
 * BOUNDARY: `parse` receives a host-app value straight off an untyped bag.
 */
export function readEntry<T>(
	bag: Readonly<Record<string, unknown>>,
	key: string,
	parse: (value: unknown) => T | undefined,
): T | undefined {
	try {
		return parse(bag[key])
	} catch {
		return undefined
	}
}

/**
 * Store `value` as an own data property. Plain assignment of `"__proto__"`
 * would try to swap the prototype and silently drop the key instead.
 */
export function defineEntry(out: Record<string, string>, key: string, value: string): void {
	Object.defineProperty(out, key, { configurable: true, enumerable: true, value, writable: true })
}

/** Coerce and cap a `track()` property bag to the `Map(String, String)` the warehouse stores. */
export function coerceTrackProps(props: TrackProps | undefined): Record<string, string> {
	const out: Record<string, string> = {}
	if (!isPropertyBag(props)) return out
	let count = 0
	let bytes = 0
	for (const rawKey of bagKeys(props)) {
		if (count >= MAX_PROPS) break
		const value = readEntry(props, rawKey, coerce)
		if (value === undefined) continue
		const key = capText(rawKey, MAX_PROP_KEY_LENGTH)
		// Two long keys can share a truncated prefix: the first one keeps it.
		if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue
		bytes += key.length + value.length
		if (bytes > MAX_TOTAL_PROP_BYTES) break
		defineEntry(out, key, value)
		count++
	}
	return out
}

// Attribute validation with the OTel JS SDK's rules: undefined is skipped, empty
// keys and invalid values are dropped, new keys stop at the count limit.
import { type AnyValue, type Attributes, diag } from "@opentelemetry/api"

export const ATTRIBUTE_COUNT_LIMIT = 128

const isScalar = (value: unknown): value is string | number | boolean =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/** `AnyValue` (api 1.10): scalars, null, bytes, and arrays or plain objects of those, without cycles. */
function isAnyValue(value: unknown, seen: WeakSet<object> = new WeakSet()): value is AnyValue {
	if (isScalar(value) || value === null || value instanceof Uint8Array) return true
	if (typeof value !== "object" || seen.has(value)) return false
	if (!Array.isArray(value) && value.constructor !== Object && value.constructor !== undefined) return false
	seen.add(value)
	const valid = Object.values(value).every((item) => item === undefined || isAnyValue(item, seen))
	seen.delete(value)
	return valid
}

/** What event attributes allow: a scalar, or an array of one scalar type (nulls allowed). */
function isSimpleValue(value: unknown): value is AnyValue {
	if (!Array.isArray(value)) return isScalar(value)
	const present = value.filter((item) => item != null)
	return present.every(isScalar) && new Set(present.map((item) => typeof item)).size <= 1
}

/** Deep copy, so a caller mutating its array or object later does not change the span. */
function copyValue(value: AnyValue): AnyValue {
	if (value === null || typeof value !== "object") return value
	if (value instanceof Uint8Array) return value.slice()
	if (Array.isArray(value)) return value.map(copyValue)
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.map(([key, item]) => [key, copyValue(item)]),
	)
}

export type AddDecision = "skipped" | "dropped" | "limit" | "added" | "replaced"

/** Set one attribute on `target`, which holds `count` keys. */
export function addAttribute(
	target: Attributes,
	count: number,
	key: string,
	value: unknown,
	simple = false,
): AddDecision {
	if (value === undefined) return "skipped"
	if (key.length === 0) {
		diag.warn(`Invalid attribute key: ${key}`)
		return "dropped"
	}
	const isNew = !Object.hasOwn(target, key)
	if (isNew && count >= ATTRIBUTE_COUNT_LIMIT) return "limit"
	const valid = simple ? isSimpleValue : isAnyValue
	if (!valid(value)) {
		diag.warn(`Invalid attribute value set for key: ${key}`)
		return "dropped"
	}
	target[key] = copyValue(value)
	return isNew ? "added" : "replaced"
}

/** A validated copy of `input`, and how many entries it dropped. */
export function cleanAttributes(
	input: Attributes | undefined,
	simple = false,
): { attributes: Attributes; dropped: number } {
	const attributes: Attributes = {}
	let count = 0
	let dropped = 0
	for (const [key, value] of Object.entries(input ?? {})) {
		const decision = addAttribute(attributes, count, key, value, simple)
		if (decision === "added") count += 1
		else if (decision === "dropped" || decision === "limit") dropped += 1
	}
	return { attributes, dropped }
}

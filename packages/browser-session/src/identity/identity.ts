import { bagKeys, capText, defineEntry, isPropertyBag, readEntry } from "../events/props"

/**
 * Who the current visitor is.
 *
 * Held in module memory only — never written to localStorage/sessionStorage.
 * An email at rest in browser storage is a PII surface with no upside here: the
 * identity is re-attached to every metadata row the SDK posts, so there is
 * nothing to persist across a reload that the host app won't re-`identify()`.
 */

/** Trait values a host app may pass. Coerced to strings before they leave. */
export type TraitValue = string | number | boolean | null | undefined

export interface MapleIdentity {
	readonly id?: string
	readonly email?: string
	readonly username?: string
	/** Company / team / tenant — the grouping dimension in the sessions UI. */
	readonly groupId?: string
	readonly groupName?: string
	/** Open-ended attributes (plan, role, …). Capped; see `MAX_TRAITS`. */
	readonly traits?: Readonly<Record<string, TraitValue>>
}

/**
 * `identify` accepts a bare user id as well as the full object — the string
 * form is what every existing caller passes, and keeping it means this can ship
 * without touching them.
 */
export type IdentifyInput = string | null | undefined | MapleIdentity

export interface ResolvedIdentity {
	readonly id?: string
	readonly email?: string
	readonly username?: string
	readonly groupId?: string
	readonly groupName?: string
	/** Coerced + capped for row size; the warehouse column is `Map(String, String)`. */
	readonly traits: Readonly<Record<string, string>>
}

/**
 * Trait caps. The warehouse column is `Map(String, String)` — plain keys
 * precisely because they are arbitrary — so the cost of a unique key per user
 * is row size and query-time map width rather than a churned dictionary. The
 * cap bounds one row's damage; `warnOnIdLikeTraitKey` surfaces the pattern to
 * whoever wrote it, since an id in a trait key is nearly always a mistake.
 */
const MAX_TRAITS = 24
const MAX_TRAIT_KEY_LENGTH = 64
const MAX_TRAIT_VALUE_LENGTH = 256
/** Ids, emails and names; matches the gateway's per-id byte cap in UTF-16 units. */
const MAX_FIELD_LENGTH = 256

let warnedAboutTraitKeys = false

/** Heuristic: a trait *key* that looks like an id is almost always a mistake. */
function looksLikeId(key: string): boolean {
	return /^[0-9a-f]{8,}$/i.test(key) || /^(usr|user|org|cus|acct)_/i.test(key)
}

function coerceTraitValue(value: unknown): string | undefined {
	switch (typeof value) {
		case "string":
			return capText(value, MAX_TRAIT_VALUE_LENGTH)
		case "number":
		case "boolean":
		case "bigint":
			return String(value)
		default:
			// Objects, functions and symbols are outside `TraitValue`; dropping them
			// beats `String()`, which can throw or yield "[object Object]".
			return undefined
	}
}

function normalizeTraits(traits: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (!isPropertyBag(traits)) return out
	let count = 0
	for (const rawKey of bagKeys(traits)) {
		if (count >= MAX_TRAITS) break
		const value = readEntry(traits, rawKey, coerceTraitValue)
		if (value === undefined) continue
		const key = capText(rawKey, MAX_TRAIT_KEY_LENGTH)
		if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue
		if (!warnedAboutTraitKeys && looksLikeId(key)) {
			warnedAboutTraitKeys = true
			console.warn(
				`[maple] identity trait key "${key}" looks like an id. A key per user widens every ` +
					"session row's trait map; put ids in the value, or in id/groupId, not the key.",
			)
		}
		defineEntry(out, key, value)
		count++
	}
	return out
}

/**
 * A trimmed, capped string field. Numeric ids (`{ id: 42 }`) are common enough in
 * untyped callers to keep; anything else that is not a string is ignored.
 */
function field(value: unknown): string | undefined {
	const text =
		typeof value === "string"
			? value
			: (typeof value === "number" && Number.isFinite(value)) || typeof value === "bigint"
				? String(value)
				: undefined
	const trimmed = text?.trim()
	return trimmed ? capText(trimmed, MAX_FIELD_LENGTH) : undefined
}

/**
 * Normalize whatever a host app passed into the shape the metadata row wants.
 *
 * Each call *replaces* the identity rather than merging into the previous one.
 * Merging would leak a signed-out user's email into the next person to use a
 * shared device, and replacement is what the existing string-only `identify`
 * already did.
 */
export function normalizeIdentity(input: IdentifyInput): ResolvedIdentity | undefined {
	if (!isPropertyBag(input)) {
		const id = field(input)
		return id ? { id, traits: {} } : undefined
	}
	const resolved: ResolvedIdentity = {
		id: readEntry(input, "id", field),
		email: readEntry(input, "email", field),
		username: readEntry(input, "username", field),
		groupId: readEntry(input, "groupId", field),
		groupName: readEntry(input, "groupName", field),
		traits: readEntry(input, "traits", normalizeTraits) ?? {},
	}
	// An object with nothing usable in it reads as "clear the identity" — the
	// same as identify(undefined).
	const hasAnything =
		resolved.id ||
		resolved.email ||
		resolved.username ||
		resolved.groupId ||
		resolved.groupName ||
		Object.keys(resolved.traits).length > 0
	return hasAnything ? resolved : undefined
}

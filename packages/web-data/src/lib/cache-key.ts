// BOUNDARY-FILE: This module intentionally carries opaque values; callers decode them before domain use.
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { snapTimestamp } from "./time-range"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

function normalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return typeof value === "string" ? snapTimestamp(value) : value
	}

	if (Arr.isArray(value)) {
		return Arr.map(value, (entry) => normalize(entry))
	}

	const entries = Arr.filter(
		Rec.toEntries(value as Record<string, unknown>),
		([, entryValue]) => entryValue !== undefined,
	).sort(([left], [right]) => Str.localeCompare(right)(left))

	const normalized: Record<string, unknown> = {}
	for (const [key, entryValue] of entries) {
		normalized[key] = normalize(entryValue)
	}

	return normalized
}

export function encodeKey(value: unknown): string {
	const normalized = normalize(value)
	return encodeJson(normalized === undefined ? null : normalized)
}

/**
 * Separator between the active org and the encoded input in an atom family key.
 *
 * Atom keys used to carry only filters and time range. The org rode along
 * invisibly in the auth header, so switching orgs left every cached entry
 * addressable by the new org: the UI re-rendered the previous org's rows until
 * the idle TTL expired — up to 30 minutes on some atoms. Electric collections
 * never had this bug because their ids already embed the org.
 *
 * The org is prefixed rather than folded into the encoded object because atoms
 * decode the key back into the query input; an extra field there would travel
 * to the server as part of the request payload.
 *
 * NUL cannot occur in `encodeKey` output (it is JSON) or in a Clerk org id, so
 * the first occurrence always marks the boundary.
 */
const ORG_KEY_SEPARATOR = "\u0000"

/** Build an org-scoped atom family key. */
export function encodeOrgScopedKey(orgId: string | null | undefined, value: unknown): string {
	return `${orgId ?? ""}${ORG_KEY_SEPARATOR}${encodeKey(value)}`
}

// Stored shapes shared by the HTTP contract (`./http/saved-views.ts`) and the Postgres table.

import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

/** The explorer a view belongs to. */
export const SavedViewSurface = Schema.Literals(["logs", "traces", "metrics"])
export type SavedViewSurface = typeof SavedViewSurface.Type

/** Who sees a view: its owner only, or everyone in the organization. */
export const SavedViewVisibility = Schema.Literals(["private", "org"])
export type SavedViewVisibility = typeof SavedViewVisibility.Type

export const SAVED_VIEW_NAME_MAX_LENGTH = 80

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/** Whether `value` nests at most `depth` levels of arrays and objects, without recursing past it. */
const isShallow = (value: unknown, depth: number): boolean => {
	const children = Arr.isArray(value) ? value : isRecord(value) ? Rec.values(value) : null
	if (children === null) return true
	return depth > 0 && Arr.every(children, (child) => isShallow(child, depth - 1))
}

// A surrogate matched on its own under the `u` flag is one with no partner.
const LONE_SURROGATE = /\p{Surrogate}/u

// Postgres jsonb refuses a NUL, and a lone surrogate cannot be put in a URL.
const isStorableText = (text: string): boolean => !Str.includes("\u0000")(text) && !LONE_SURROGATE.test(text)

/**
 * Every string in `value`, keys included, is one Postgres can store and a URL can carry.
 * Anything nested past `depth` is refused, so the walk is as bounded as `isShallow`.
 */
const hasStorableText = (value: unknown, depth: number): boolean => {
	if (typeof value === "string") return isStorableText(value)
	const entries = Arr.isArray(value)
		? Arr.map(value, (child): [string, unknown] => ["", child])
		: isRecord(value)
			? Rec.toEntries(value)
			: null
	if (entries === null) return true
	return (
		depth > 0 &&
		Arr.every(entries, ([key, child]) => isStorableText(key) && hasStorableText(child, depth - 1))
	)
}

/** A view's name: trimmed, one to 80 characters. */
export const SavedViewName = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(SAVED_VIEW_NAME_MAX_LENGTH),
	Schema.makeFilter((name: string) => isStorableText(name) || "name holds text that cannot be stored", {
		identifier: "SavedViewNameText",
	}),
)

// A where clause plus a full set of facets is a few hundred bytes; this leaves two orders of room.
const STATE_MAX_BYTES = 16_000
const STATE_MAX_PARAMS = 64
// A param's value is a string, a list of strings or a small object; nothing nests deeper.
const STATE_MAX_DEPTH = 8

const SearchParams = Schema.Record(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	Schema.Json,
)

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const utf8 = new TextEncoder()

/** The state's size in bytes as stored; a value JSON cannot hold counts as too large. */
const storedSizeOf = (state: unknown): number =>
	Option.match(encodeJson(state), {
		onNone: () => Infinity,
		onSome: (json) => utf8.encode(json).length,
	})

/**
 * What a view restores: the explorer's URL search params as the route decoded them, and for a
 * metric's own page the metric it is about. The explorer reads it back through its route's search
 * schema, so a param that has since been renamed or removed is dropped, not an error.
 */
export const SavedViewState = Schema.Struct({
	search: SearchParams,
	metricName: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
}).check(
	Schema.makeFilter(
		(state: { readonly search: typeof SearchParams.Type }) =>
			Rec.keys(state.search).length <= STATE_MAX_PARAMS || "too many search params",
		{ identifier: "SavedViewStateParams" },
	),
	// Before the size check, which serializes the state: depth is what could overflow the stack there.
	Schema.makeFilter(
		(state: { readonly search: typeof SearchParams.Type }) =>
			isShallow(state.search, STATE_MAX_DEPTH) || "saved view state is nested too deeply",
		{ identifier: "SavedViewStateDepth" },
	),
	Schema.makeFilter(
		(state: unknown) =>
			hasStorableText(state, STATE_MAX_DEPTH + 2) ||
			"saved view state holds text that cannot be stored",
		{
			identifier: "SavedViewStateText",
		},
	),
	Schema.makeFilter(
		(state: { readonly search: typeof SearchParams.Type }) =>
			storedSizeOf(state) <= STATE_MAX_BYTES || "saved view state is too large",
		{ identifier: "SavedViewStateSize" },
	),
)
export type SavedViewState = typeof SavedViewState.Type

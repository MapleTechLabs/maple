// Stored shapes shared by the HTTP contract (`./http/saved-views.ts`) and the Postgres table.

import { Option, Record as Rec, Schema } from "effect"

/** The explorer a view belongs to. */
export const SavedViewSurface = Schema.Literals(["logs", "traces", "metrics"])
export type SavedViewSurface = typeof SavedViewSurface.Type

/** Who sees a view: its owner only, or everyone in the organization. */
export const SavedViewVisibility = Schema.Literals(["private", "org"])
export type SavedViewVisibility = typeof SavedViewVisibility.Type

export const SAVED_VIEW_NAME_MAX_LENGTH = 80

/** A view's name: trimmed, one to 80 characters. */
export const SavedViewName = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(SAVED_VIEW_NAME_MAX_LENGTH),
)

// A where clause plus a full set of facets is a few hundred bytes; this leaves two orders of room.
const STATE_MAX_BYTES = 16_000
const STATE_MAX_PARAMS = 64

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
	Schema.makeFilter(
		(state: { readonly search: typeof SearchParams.Type }) =>
			storedSizeOf(state) <= STATE_MAX_BYTES || "saved view state is too large",
		{ identifier: "SavedViewStateSize" },
	),
)
export type SavedViewState = typeof SavedViewState.Type

import type { SavedViewState, SavedViewSurface } from "@maple/domain/saved-views"
import { Array as Arr, Option, Record as Rec, Schema } from "effect"

// What a saved view stores and how it is read back: the explorer's URL search params, and nothing
// that is not in the URL.

/** An explorer page as the Views control sees it. */
export type Explorer = Readonly<{
	surface: SavedViewSurface
	/** What saving now would store. */
	current: SavedViewState
	/** The URL a stored state opens. Two states are the same view when their URLs are. */
	hrefOf: (state: SavedViewState) => string
}>

const decodeParams = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/**
 * A page's decoded search as a view stores it: every param the URL carries, minus `transient`
 * ones that belong to one visit (an open peek sheet). A relative window is its `timePreset`, an
 * absolute one its `startTime` and `endTime`, exactly as the URL holds them.
 */
export const searchParamsOf = (
	search: Readonly<Record<string, unknown>>,
	transient: ReadonlyArray<string> = [],
): SavedViewState["search"] =>
	Option.getOrElse(
		decodeParams(
			Rec.filter(search, (value, key) => value !== undefined && !Arr.contains(transient, key)),
		),
		() => ({}),
	)

/**
 * Stored params through the route's search schema. A param the route no longer knows is dropped
 * by the schema; one it now rejects is dropped here, so the rest of the view still opens.
 */
export const readSearch = <A, I>(
	schema: Schema.Codec<A, I>,
	stored: SavedViewState["search"],
	fallback: A,
): A => {
	const decode = Schema.decodeUnknownOption(schema)
	return Option.getOrElse(
		Option.orElse(decode(stored), () =>
			decode(Rec.filter(stored, (value, key) => Option.isSome(decode({ [key]: value })))),
		),
		() => fallback,
	)
}

/**
 * `hrefOf`, computed once per stored state: the button and the menu ask for every view's URL on
 * each render, and the Model keeps a view's state by reference.
 */
export const memoHref = (hrefOf: (state: SavedViewState) => string): ((state: SavedViewState) => string) => {
	const hrefs = new WeakMap<SavedViewState, string>()
	return (state) => {
		const known = hrefs.get(state)
		if (known !== undefined) return known
		const href = hrefOf(state)
		hrefs.set(state, href)
		return href
	}
}

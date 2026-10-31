import type { Html, HtmlBuilder } from "foldkit/html"
import { searchInput } from "../../../ui/search-input"

// The Pull requests and Issues search box: typing is debounced into the URL's `q`.

export const SEARCH_DEBOUNCE_MS = 300
/** `CodeReviewListQuery`'s `q` cap: a longer term would be a 400. */
const MAX_TERM = 200

/** What the draft commits to the URL: trimmed, and nothing when blank. */
export const draftQuery = (draft: string): string | undefined => draft.trim().slice(0, MAX_TERM) || undefined

/** The draft after a route change: kept while it still means the URL's `q`, else the URL's. */
export const syncedDraft = (draft: string, q: string | undefined): string =>
	draftQuery(draft) === q ? draft : (q ?? "")

export type SearchBoxOptions<M> = Readonly<{
	id: string
	value: string
	placeholder: string
	onInput: (value: string) => M
}>

export const searchBox = <M>(h: HtmlBuilder<M>, options: SearchBoxOptions<M>): Html =>
	searchInput(h, {
		id: options.id,
		size: "sm",
		className: "w-64 min-w-0",
		placeholder: options.placeholder,
		ariaLabel: options.placeholder,
		value: options.value,
		onInput: options.onInput,
		onClear: options.onInput(""),
	})

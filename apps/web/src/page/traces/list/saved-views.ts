import { AppRoute, hrefOf } from "../../../route"
import { TracesSearch } from "../../../route/search"
import { lastBy } from "../../kit/last-by"
import * as SavedViews from "../../kit/saved-views"
import type { Search } from "./derive"

// The traces explorer as its Views control reads it: filters, sort and window.

/** The open peek sheet is one visit's, not the view's. */
const PEEK_PARAMS = ["peek", "peekRow", "peekT", "peekSpan"]

const viewHref = SavedViews.memoHref((state) =>
	hrefOf(AppRoute.Traces({ search: SavedViews.readSearch(TracesSearch, state.search, {}) })),
)

/** Rebuilt only when the URL search changes. */
export const viewsExplorer = lastBy(([search]: readonly [Search]): SavedViews.Explorer => ({
	surface: "traces",
	current: { search: SavedViews.searchParamsOf(search, PEEK_PARAMS) },
	hrefOf: viewHref,
}))

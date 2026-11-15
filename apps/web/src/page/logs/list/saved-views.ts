import { AppRoute, hrefOf } from "../../../route"
import { LogsSearch } from "../../../route/search"
import { lastBy } from "../../kit/last-by"
import * as SavedViews from "../../kit/saved-views"
import type { Search } from "./derive"

// The logs explorer as its Views control reads it: every param of `/logs` is part of a view.

const viewHref = SavedViews.memoHref((state) =>
	hrefOf(AppRoute.Logs({ search: SavedViews.readSearch(LogsSearch, state.search, {}) })),
)

/** Rebuilt only when the URL search changes. */
export const viewsExplorer = lastBy(([search]: readonly [Search]): SavedViews.Explorer => ({
	surface: "logs",
	current: { search: SavedViews.searchParamsOf(search) },
	hrefOf: viewHref,
}))

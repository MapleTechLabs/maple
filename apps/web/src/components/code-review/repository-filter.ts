import { Array as Arr, String as Str } from "effect"
export type RepositoryFilter = "all" | "reviewed" | "off"

/** Below this the whole list fits at a glance and a search bar is noise. */
export const SEARCH_THRESHOLD = 8

interface FilterableRepository {
	readonly id: string
	readonly fullName: string
	readonly prReviewEnabled: boolean
}

/**
 * The rows the repository list shows: matching the search and review filter, `pinned` first, then
 * by name. Without the toolbar (a short list) there is no control to undo either, so neither applies.
 */
export function visibleRepositories<R extends FilterableRepository>(
	repositories: ReadonlyArray<R>,
	{ search, filter, pinned }: { search: string; filter: RepositoryFilter; pinned: ReadonlySet<string> },
): ReadonlyArray<R> {
	const showToolbar = repositories.length > SEARCH_THRESHOLD
	const needle = showToolbar ? Str.toLowerCase(Str.trim(search)) : ""
	const activeFilter = showToolbar ? filter : "all"
	return Arr.filter(
		repositories,
		(repo) =>
			(activeFilter === "all" || repo.prReviewEnabled === (activeFilter === "reviewed")) &&
			(needle.length === 0 || Str.includes(needle)(Str.toLowerCase(repo.fullName))),
	).toSorted(
		(a, b) =>
			Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
			a.fullName.localeCompare(b.fullName, undefined, { numeric: true, sensitivity: "base" }),
	)
}

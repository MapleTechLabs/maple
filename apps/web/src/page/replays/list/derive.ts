import type { SessionTag } from "@maple/domain/query-engine"
import { isQualityTier, sessionTagsFromSearch } from "../../../components/replays/session-tags"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { formatCompact } from "../../../ui/filters/range-format"
import type { SessionRow } from "../kit/session-row"
import type { Model, ReplaysFacets, Search } from "./model"

/** `MAX_RETAINED_REPLAYS`. */
export const MAX_RETAINED_REPLAYS = 500

export const selectedTags = (search: Search): ReadonlyArray<SessionTag> =>
	sessionTagsFromSearch(search.tags) ?? []

/** `allData`: the first page then every later one, capped. */
export const allRows = (model: Model): ReadonlyArray<SessionRow> =>
	Option.match(AsyncData.getData(model.firstPage.data), {
		onNone: () => [],
		onSome: (first) =>
			[...first.rows, ...model.pagination.pages.flatMap((page) => page.rows)].slice(
				0,
				MAX_RETAINED_REPLAYS,
			),
	})

/** The cursor of the last page, while more remain and the cap has not been reached. */
export const nextCursor = (model: Model): string | null => {
	if (model.pagination.isStopped || allRows(model).length >= MAX_RETAINED_REPLAYS) return null
	const last =
		model.pagination.pages.at(-1) ?? Option.getOrUndefined(AsyncData.getData(model.firstPage.data))
	return last?.hasMore === true ? last.nextCursor : null
}

/** `ReachEndSentinel` re-observes when `loading` or its `onReachEnd` deps change: the remount key. */
export const listEndKey = (model: Model): string =>
	[
		model.pagination.generation,
		model.pagination.isFetching ? "fetching" : "idle",
		AsyncData.isSuccess(model.firstPage.data) ? "settled" : "waiting",
		nextCursor(model) ?? "",
	].join("|")

export const isCapped = (model: Model): boolean => allRows(model).length >= MAX_RETAINED_REPLAYS

/** The list header's `hasActiveFilters`: any filter or search narrows the list. */
export const hasActiveFilters = (search: Search): boolean =>
	[
		search.service,
		search.browser,
		search.country,
		search.deviceType,
		search.userId,
		search.user,
		search.group,
		search.visitorId,
		search.hasErrors,
		search.q,
		search.page,
		search.tags !== undefined && search.tags.length > 0 ? search.tags : undefined,
		search.durationMin,
		search.durationMax,
		search.activeMin,
		search.activeMax,
	].some((value) => value !== undefined && value !== "" && value !== false)

/** The sidebar's own `hasActiveFilters` (no `q`, no visitor). */
export const hasSidebarFilters = (search: Search): boolean =>
	Boolean(search.service) ||
	Boolean(search.browser) ||
	Boolean(search.country) ||
	Boolean(search.deviceType) ||
	Boolean(search.userId) ||
	Boolean(search.user) ||
	Boolean(search.group) ||
	Boolean(search.page) ||
	(search.tags?.length ?? 0) > 0 ||
	search.hasErrors === true ||
	search.durationMin !== undefined ||
	search.durationMax !== undefined ||
	search.activeMin !== undefined ||
	search.activeMax !== undefined

/** The facets once loaded (refreshing keeps the previous answer). */
export const facetsOf = (model: Model): ReplaysFacets | undefined =>
	Option.getOrUndefined(AsyncData.getData(model.facets.data))

/** "engaged" chip count: the list itself once engaged is selected, else the tag facet. */
export const engagedCount = (model: Model): number | undefined => {
	const facets = facetsOf(model)
	if (selectedTags(model.search).includes("engaged")) return facets?.totalSessions
	if (facets === undefined) return undefined
	return facets.tags.find((tag) => tag.name === "engaged")?.count ?? 0
}

/** A tier filter already decided what to show; folding its rows would hide the answer. */
export const collapsesLowSignal = (search: Search): boolean => !selectedTags(search).some(isQualityTier)

export const draftOf = (min: number | undefined, max: number | undefined) => ({
	min: formatCompact(min, "s"),
	max: formatCompact(max, "s"),
})

import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import type { DashboardsSearch } from "../../../route/search"
import type { DashboardDocument } from "@maple/domain/http"
import {
	dashboardDomains,
	type DashboardSortOption,
	epochOf,
	isDashboardSortOption,
	readsFromLabel,
} from "../kit/summary"
import type { Glyph, ListDashboard, Model, Scope } from "./model"

// The pure halves of `DashboardList` and `dashboard-summary.ts`.

type Search = typeof DashboardsSearch.Type

/** "Untitled dashboard" for a blank name (`displayName`). */
export const displayName = (name: string | undefined): string =>
	name !== undefined && name.trim() !== "" ? name : "Untitled dashboard"

/** `dashboardMatches`: name, description or tag contains the query. */
export const dashboardMatches = (dashboard: ListDashboard, query: string): boolean => {
	const needle = query.trim().toLowerCase()
	if (needle.length === 0) return true
	return (
		dashboard.name.toLowerCase().includes(needle) ||
		(dashboard.description?.toLowerCase().includes(needle) ?? false) ||
		dashboard.tags.some((tag) => tag.toLowerCase().includes(needle))
	)
}

export const collectTags = (dashboards: ReadonlyArray<ListDashboard>): ReadonlyArray<string> =>
	Array.from(new Set(dashboards.flatMap((dashboard) => dashboard.tags))).sort()

export const matchesTags = (dashboard: ListDashboard, tags: ReadonlyArray<string>): boolean =>
	tags.every((tag) => dashboard.tags.includes(tag))

export const sortDashboards = (
	dashboards: ReadonlyArray<ListDashboard>,
	sort: DashboardSortOption,
): ReadonlyArray<ListDashboard> =>
	dashboards.toSorted((a, b) => {
		switch (sort) {
			case "name-asc":
				return a.name.localeCompare(b.name)
			case "name-desc":
				return b.name.localeCompare(a.name)
			case "created":
				return epochOf(b.createdAt) - epochOf(a.createdAt)
			case "widgets":
				return b.widgetCount - a.widgetCount
			case "updated":
				return epochOf(b.updatedAt) - epochOf(a.updatedAt)
		}
	})

/** `headerSummary` with `formatRelativeTimeOrDate`. */
export const headerSummary = (
	dashboards: ReadonlyArray<ListDashboard>,
	nowMs: number,
	timeZone: string,
	locale: string,
): string => {
	if (dashboards.length === 0) return "No dashboards yet"
	const widgets = dashboards.reduce((total, dashboard) => total + dashboard.widgetCount, 0)
	const parts = [
		countLabel(dashboards.length, "dashboard", undefined, locale),
		countLabel(widgets, "widget", undefined, locale),
	]
	const latest = dashboards.reduce<string | null>(
		(newest, dashboard) =>
			newest === null || epochOf(dashboard.updatedAt) > epochOf(newest) ? dashboard.updatedAt : newest,
		null,
	)
	if (latest !== null) parts.push(`last edited ${formatRelativeTimeOrDate(latest, nowMs, timeZone, locale)}`)
	const empty = dashboards.filter((dashboard) => dashboard.widgetCount === 0).length
	if (empty > 0) parts.push(`${empty} with no widgets`)
	return parts.join(" · ")
}

export const queryOf = (search: Search): string => search.q ?? ""
export const scopeOf = (search: Search): Scope => search.scope ?? "all"
export const tagsOf = (search: Search): ReadonlyArray<string> => search.tags ?? []

/** The URL's sort, else the stored default, else "updated". */
export const sortOf = (model: Model): DashboardSortOption =>
	model.search.sort ?? (isDashboardSortOption(model.storedSort) ? model.storedSort : "updated")

export type ListSections = Readonly<{
	favorited: ReadonlyArray<ListDashboard>
	others: ReadonlyArray<ListDashboard>
	matched: number
	scoped: number
}>

/** `DashboardList`'s memo: search and tags, then scope, then the chosen sort. */
export const sectionsOf = (model: Model, dashboards: ReadonlyArray<ListDashboard>): ListSections => {
	const query = queryOf(model.search)
	const tags = tagsOf(model.search)
	const scope = scopeOf(model.search)
	const isFavorite = (dashboard: ListDashboard) => model.favorites.includes(dashboard.id)
	const searched = dashboards.filter(
		(dashboard) => dashboardMatches(dashboard, query) && matchesTags(dashboard, tags),
	)
	const inScope = scope === "favorites" ? searched.filter(isFavorite) : searched
	const sorted = sortDashboards(inScope, sortOf(model))
	return {
		favorited: sorted.filter(isFavorite),
		others: scope === "favorites" ? [] : sorted.filter((dashboard) => !isFavorite(dashboard)),
		matched: searched.length,
		scoped: inScope.length,
	}
}

/** `dashboardGlyph`. */
const glyphOf = (document: DashboardDocument): Glyph => {
	if (document.widgets.length === 0) return "GridIcon"
	switch (dashboardDomains(document)[0]) {
		case "Traces":
			return "PulseIcon"
		case "Logs":
			return "TextWrapIcon"
		case "Errors":
			return "CircleWarningIcon"
		case "Metrics":
			return "ChartBarIcon"
		case "Raw SQL":
			return "CodeIcon"
		case undefined:
			return "FileIcon"
	}
}

export const toListDashboard = (document: DashboardDocument): ListDashboard => {
	const reads = readsFromLabel(document)
	return {
		id: document.id,
		name: document.name,
		description: document.description ?? null,
		tags: document.tags ?? [],
		widgetCount: document.widgets.length,
		readsShort: reads.short,
		readsFull: reads.full,
		glyph: glyphOf(document),
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	}
}

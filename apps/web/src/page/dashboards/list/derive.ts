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
import { Array as Arr, String as Str, Order } from "effect"

// The pure halves of `DashboardList` and `dashboard-summary.ts`.

type Search = typeof DashboardsSearch.Type

/** "Untitled dashboard" for a blank name (`displayName`). */
export const displayName = (name: string | undefined): string =>
	name !== undefined && Str.trim(name) !== "" ? name : "Untitled dashboard"

/** `dashboardMatches`: name, description or tag contains the query. */
export const dashboardMatches = (dashboard: ListDashboard, query: string): boolean => {
	const needle = Str.toLowerCase(Str.trim(query))
	if (needle.length === 0) return true
	return (
		Str.includes(needle)(Str.toLowerCase(dashboard.name)) ||
		(dashboard.description !== null &&
			dashboard.description !== undefined &&
			Str.includes(needle)(Str.toLowerCase(dashboard.description))) ||
		Arr.some(dashboard.tags, (tag) => Str.includes(needle)(Str.toLowerCase(tag)))
	)
}

export const collectTags = (dashboards: ReadonlyArray<ListDashboard>): ReadonlyArray<string> =>
	Array.from(new Set(Arr.flatMap(dashboards, (dashboard) => dashboard.tags))).sort()

export const matchesTags = (dashboard: ListDashboard, tags: ReadonlyArray<string>): boolean =>
	Arr.every(tags, (tag) => dashboard.tags.includes(tag))

export const sortDashboards = (
	dashboards: ReadonlyArray<ListDashboard>,
	sort: DashboardSortOption,
): ReadonlyArray<ListDashboard> =>
	Arr.sort(dashboards, (a: ListDashboard, b: ListDashboard) => {
		switch (sort) {
			case "name-asc":
				return Str.localeCompare(b.name)(a.name)
			case "name-desc":
				return Str.localeCompare(a.name)(b.name)
			case "created":
				return Order.Number(epochOf(b.createdAt), epochOf(a.createdAt))
			case "widgets":
				return Order.Number(b.widgetCount, a.widgetCount)
			case "updated":
				return Order.Number(epochOf(b.updatedAt), epochOf(a.updatedAt))
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
	const widgets = Arr.reduce(dashboards, 0, (total, dashboard) => total + dashboard.widgetCount)
	const parts = [
		countLabel(dashboards.length, "dashboard", undefined, locale),
		countLabel(widgets, "widget", undefined, locale),
	]
	const latest = Arr.reduce<ListDashboard, string | null>(dashboards, null, (newest, dashboard) =>
		newest === null || epochOf(dashboard.updatedAt) > epochOf(newest) ? dashboard.updatedAt : newest,
	)
	if (latest !== null)
		parts.push(`last edited ${formatRelativeTimeOrDate(latest, nowMs, timeZone, locale)}`)
	const empty = Arr.filter(dashboards, (dashboard) => dashboard.widgetCount === 0).length
	if (empty > 0) parts.push(`${empty} with no widgets`)
	return Arr.join(parts, " · ")
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
	const searched = Arr.filter(
		dashboards,
		(dashboard) => dashboardMatches(dashboard, query) && matchesTags(dashboard, tags),
	)
	const inScope = scope === "favorites" ? Arr.filter(searched, isFavorite) : searched
	const sorted = sortDashboards(inScope, sortOf(model))
	return {
		favorited: Arr.filter(sorted, isFavorite),
		others: scope === "favorites" ? [] : Arr.filter(sorted, (dashboard) => !isFavorite(dashboard)),
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

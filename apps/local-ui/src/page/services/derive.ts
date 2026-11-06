import type { FilterOption } from "@maple/views/ui/filters/filter-section"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Catalog, Model, ServiceCatalogEntry } from "./model"

// The derived parts of `useLocalServiceCatalog` and `ServicesListView`.

export interface ServicesFilters {
	readonly env: string | undefined
	readonly ns: string | undefined
	readonly search: string | undefined
}

export const filtersOf = (query: URLSearchParams): ServicesFilters => ({
	env: query.get("env") || undefined,
	ns: query.get("ns") || undefined,
	search: query.get("q") || undefined,
})

export const activeFilterCount = (filters: ServicesFilters): number =>
	Arr.filter([filters.env, filters.ns], Boolean).length

const dataOf = (slot: Model["catalog"]): Catalog => Option.getOrElse(AsyncData.getData(slot.data), () => [])

/** The rows: the filtered catalog, narrowed client-side by the name search. */
export const visibleEntries = (
	model: Model,
	filters: ServicesFilters,
): ReadonlyArray<ServiceCatalogEntry> => {
	const all = dataOf(model.catalog)
	const needle = filters.search === undefined ? undefined : Str.toLowerCase(filters.search)
	return needle ? Arr.filter(all, (entry) => Str.includes(needle)(Str.toLowerCase(entry.serviceName))) : all
}

/** With no filter the filtered and unfiltered queries are one key, so the rows slot answers both. */
export const unfilteredSlot = (model: Model, filters: ServicesFilters): Model["catalog"] =>
	activeFilterCount(filters) === 0 ? model.catalog : model.unfiltered

const countBy = (
	entries: ReadonlyArray<ServiceCatalogEntry>,
	pick: (entry: ServiceCatalogEntry) => ReadonlyArray<string>,
): ReadonlyArray<FilterOption> => {
	const counts = new Map<string, number>()
	Arr.forEach(entries, (entry) =>
		Arr.forEach(pick(entry), (name) => counts.set(name, (counts.get(name) ?? 0) + 1)),
	)
	return Arr.map([...counts.entries()], ([name, count]) => ({ name, count })).sort((a, b) =>
		b.count !== a.count ? b.count - a.count : Str.localeCompare(b.name)(a.name),
	)
}

/** Facets from the unfiltered catalog, each counted under the other facet only. */
export const facetsOf = (model: Model, filters: ServicesFilters) => {
	const all = dataOf(unfilteredSlot(model, filters))
	const { env, ns } = filters
	return {
		envFacets: countBy(
			ns ? Arr.filter(all, (e) => e.serviceNamespaces.includes(ns)) : all,
			(e) => e.deploymentEnvironments,
		),
		nsFacets: countBy(
			env ? Arr.filter(all, (e) => e.deploymentEnvironments.includes(env)) : all,
			(e) => e.serviceNamespaces,
		),
	}
}

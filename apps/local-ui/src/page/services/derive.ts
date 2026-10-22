import type { FilterOption } from "@maple/web/ui/filters/filter-section"
import { Option } from "effect"
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
	[filters.env, filters.ns].filter(Boolean).length

const dataOf = (slot: Model["catalog"]): Catalog => Option.getOrElse(AsyncData.getData(slot.data), () => [])

/** The rows: the filtered catalog, narrowed client-side by the name search. */
export const visibleEntries = (model: Model, filters: ServicesFilters): ReadonlyArray<ServiceCatalogEntry> => {
	const all = dataOf(model.catalog)
	const needle = filters.search?.toLowerCase()
	return needle ? all.filter((entry) => entry.serviceName.toLowerCase().includes(needle)) : all
}

/** With no filter the filtered and unfiltered queries are one key, so the rows slot answers both. */
export const unfilteredSlot = (model: Model, filters: ServicesFilters): Model["catalog"] =>
	activeFilterCount(filters) === 0 ? model.catalog : model.unfiltered

const countBy = (
	entries: ReadonlyArray<ServiceCatalogEntry>,
	pick: (entry: ServiceCatalogEntry) => ReadonlyArray<string>,
): ReadonlyArray<FilterOption> => {
	const counts = new Map<string, number>()
	entries.forEach((entry) => pick(entry).forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1)))
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Facets from the unfiltered catalog, each counted under the other facet only. */
export const facetsOf = (model: Model, filters: ServicesFilters) => {
	const all = dataOf(unfilteredSlot(model, filters))
	const { env, ns } = filters
	return {
		envFacets: countBy(ns ? all.filter((e) => e.serviceNamespaces.includes(ns)) : all, (e) => e.deploymentEnvironments),
		nsFacets: countBy(env ? all.filter((e) => e.deploymentEnvironments.includes(env)) : all, (e) => e.serviceNamespaces),
	}
}

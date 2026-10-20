import { formatCompact } from "../../../ui/filters/range-format"
import { excludedOf, type Search } from "./derive"
import type { Facet } from "./message"

// The search edits the list's controls make (`onFilterChange`, `toggleOption`, `applyWhereClause`).

/** An empty list leaves the URL. */
const listOrUndefined = (values: ReadonlyArray<string>) => (values.length === 0 ? undefined : values)

/** `FilterSection`'s toggle: include and exclude are exclusive per value. */
export const toggledFacet = (search: Search, facet: Facet, name: string): Search => {
	const excludedParam = excludedOf(facet)
	const selected = search[facet] ?? []
	const excluded = search[excludedParam] ?? []
	return {
		...search,
		[excludedParam]: excluded.includes(name)
			? listOrUndefined(excluded.filter((v) => v !== name))
			: search[excludedParam],
		[facet]: listOrUndefined(
			selected.includes(name) ? selected.filter((v) => v !== name) : [...selected, name],
		),
	}
}

export const excludedFacet = (search: Search, facet: Facet, name: string): Search => {
	const excludedParam = excludedOf(facet)
	const selected = search[facet] ?? []
	const excluded = search[excludedParam] ?? []
	return {
		...search,
		[facet]: selected.includes(name)
			? listOrUndefined(selected.filter((v) => v !== name))
			: search[facet],
		[excludedParam]: listOrUndefined(
			excluded.includes(name) ? excluded.filter((v) => v !== name) : [...excluded, name],
		),
	}
}

export const onlyFacet = (search: Search, facet: Facet, name: string): Search => ({
	...search,
	[facet]: [name],
	[excludedOf(facet)]: undefined,
})

/** `applyWhereClause(search, "")`: the clause and every param a clause can set leave the URL. */
export const clearedWhereClause = (search: Search): Search => ({
	...search,
	whereClause: undefined,
	services: undefined,
	spanNames: undefined,
	hasError: undefined,
	minDurationMs: undefined,
	maxDurationMs: undefined,
	httpMethods: undefined,
	httpStatusCodes: undefined,
	deploymentEnvs: undefined,
	namespaces: undefined,
	rootOnly: undefined,
	attributeFilters: undefined,
	resourceAttributeFilters: undefined,
	serviceMatchMode: undefined,
	spanNameMatchMode: undefined,
	deploymentEnvMatchMode: undefined,
	namespaceMatchMode: undefined,
	excludedServices: undefined,
	excludedSpanNames: undefined,
	excludedDeploymentEnvs: undefined,
	excludedNamespaces: undefined,
	excludedHttpMethods: undefined,
	excludedHttpStatusCodes: undefined,
})

/** `RangeFilterSection.emit`: a reversed pair is swapped rather than committed. */
export const withDuration = (search: Search, min: number | undefined, max: number | undefined): Search => {
	const [low, high] = min !== undefined && max !== undefined && min > max ? [max, min] : [min, max]
	return { ...search, minDurationMs: low, maxDurationMs: high }
}

export const durationDraftOf = (search: Search) => ({
	min: formatCompact(search.minDurationMs, "ms"),
	max: formatCompact(search.maxDurationMs, "ms"),
})

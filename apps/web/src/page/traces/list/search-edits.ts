import { formatCompact } from "@maple/views/ui/filters/range-format"
import type { Search } from "./derive"

// The search edits the list's controls make (`onFilterChange`, `toggleOption`, `applyWhereClause`).

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

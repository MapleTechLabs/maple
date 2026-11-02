import {
	decodeLogAttributeFilters,
	encodeLogAttributeFilter,
	type LogAttributeFilter,
} from "@maple/views/lib/log-attribute-filters"

// The Logs page's filters, mode and pinned columns from the hash query.

export interface LogFilters {
	/** Exact service name match. */
	readonly service?: string
	/** Exact severity text match (e.g. `ERROR`). */
	readonly severity?: string
	/** Substring match on the log body. */
	readonly search?: string
	/** `attrs` entries (`[!]log:<key>=<value>`), as the dashboard spells them. */
	readonly attrs: ReadonlyArray<string>
}

export type LogsMode = "list" | "patterns"

export const filtersOf = (query: URLSearchParams): LogFilters => ({
	service: query.get("service") || undefined,
	severity: query.get("severity") || undefined,
	search: query.get("q") || undefined,
	attrs: query.getAll("attrs"),
})

export const modeOf = (query: URLSearchParams): LogsMode => (query.get("mode") === "patterns" ? "patterns" : "list")

/** The attribute keys pinned as stream columns, in pin order. */
export const columnsOf = (query: URLSearchParams): ReadonlyArray<string> => query.getAll("columns")

const sameFilter = (a: LogAttributeFilter, b: LogAttributeFilter) =>
	a.source === b.source && a.key === b.key && a.value === b.value && a.negated === b.negated

/** The decoded `attrs`, each filter once (a hand-edited URL may repeat one). */
export const attributeFiltersOf = (filters: LogFilters): ReadonlyArray<LogAttributeFilter> =>
	decodeLogAttributeFilters(filters.attrs).filter(
		(filter, index, all) => all.findIndex((other) => sameFilter(other, filter)) === index,
	)

/** The `attrs` entries without `removed`, compared decoded so any spelling of it goes. */
export const withoutAttributeFilter = (filters: LogFilters, removed: LogAttributeFilter): ReadonlyArray<string> =>
	attributeFiltersOf(filters)
		.filter((filter) => !sameFilter(filter, removed))
		.map(encodeLogAttributeFilter)

/** The rail's filters (service and severity), counted on the small-screen Filters button. */
export const activeFilterCount = (filters: LogFilters): number =>
	[filters.service, filters.severity].filter(Boolean).length

/** Anything narrows the list: a rail filter, an attribute filter or a search. */
export const isFiltered = (filters: LogFilters): boolean =>
	activeFilterCount(filters) > 0 || filters.attrs.length > 0 || filters.search !== undefined

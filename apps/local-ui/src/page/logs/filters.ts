// The Logs page's filters and mode from the hash query.

export interface LogFilters {
	/** Exact service name match. */
	readonly service?: string
	/** Exact severity text match (e.g. `ERROR`). */
	readonly severity?: string
	/** Substring match on the log body. */
	readonly search?: string
}

export type LogsMode = "list" | "patterns"

export const filtersOf = (query: URLSearchParams): LogFilters => ({
	service: query.get("service") || undefined,
	severity: query.get("severity") || undefined,
	search: query.get("q") || undefined,
})

export const modeOf = (query: URLSearchParams): LogsMode =>
	query.get("mode") === "patterns" ? "patterns" : "list"

export const activeFilterCount = (filters: LogFilters): number =>
	[filters.service, filters.severity].filter(Boolean).length

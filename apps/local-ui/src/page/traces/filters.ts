// The traces list's filters from the hash query.

export interface TraceFilters {
	readonly search?: string
	readonly service?: string
	readonly span?: string
	readonly errorsOnly?: boolean
	readonly method?: string
	readonly status?: string
	readonly env?: string
	readonly ns?: string
	readonly minDurationMs?: number
	readonly maxDurationMs?: number
	readonly scope?: "root" | "spans"
}

/** Parse a URL param as a non-negative integer; anything else means "unset". */
export const parseNonNegativeInt = (raw: string | null): number | undefined => {
	if (!raw) return undefined
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
}

export const FILTER_KEYS = [
	"service",
	"span",
	"errors",
	"method",
	"status",
	"env",
	"ns",
	"minDur",
	"maxDur",
] as const

export const filtersOf = (query: URLSearchParams): TraceFilters => ({
	search: query.get("q") || undefined,
	service: query.get("service") || undefined,
	span: query.get("span") || undefined,
	errorsOnly: query.get("errors") === "1",
	method: query.get("method") || undefined,
	status: query.get("status") || undefined,
	env: query.get("env") || undefined,
	ns: query.get("ns") || undefined,
	minDurationMs: parseNonNegativeInt(query.get("minDur")),
	maxDurationMs: parseNonNegativeInt(query.get("maxDur")),
	scope: query.get("scope") === "spans" ? "spans" : "root",
})

export const activeFilterCount = (query: URLSearchParams): number =>
	FILTER_KEYS.filter((key) => query.get(key)).length

/** `clearFilters`: every sidebar filter, the search and the span scope. */
export const clearedFilters = (): Readonly<Record<string, null>> => ({
	...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])),
	q: null,
	scope: null,
})

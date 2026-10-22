import { Option, Schema } from "effect"
import type { CacheValue, QueryKey } from "../../data/cache-store"
import { cachedAs } from "../../data/cached"
import { nextCursor } from "./fetch"
import { filtersOf } from "./filters"
import { FacetOption, LocalLog, LogPattern, type LogPages, type LogPatterns } from "./model"

// The logs queries' keys and data, as the result cache keeps them.

type Window = Readonly<{ search: string; startTime: string; endTime: string }>

const windowOf = (window: Window) => `${window.startTime}/${window.endTime}`
const filtersFrom = (window: Window) => filtersOf(new URLSearchParams(window.search))

/** `["local", "logs", filters, boundsKey]`. */
export const logsKey = (window: Window): QueryKey => ["local", "logs", filtersFrom(window), windowOf(window)]

/** `["local", "log-patterns", filters, boundsKey]`. */
export const patternsKey = (window: Window): QueryKey => ["local", "log-patterns", filtersFrom(window), windowOf(window)]

/** `["local", "logs", "services", severity, search, boundsKey]`. */
export const servicesKey = (window: Window): QueryKey => {
	const filters = filtersFrom(window)
	return ["local", "logs", "services", filters.severity ?? null, filters.search ?? null, windowOf(window)]
}

/** `["local", "log-severities", service, search, boundsKey]`. */
export const severitiesKey = (window: Window): QueryKey => {
	const filters = filtersFrom(window)
	return ["local", "log-severities", filters.service ?? null, filters.search ?? null, windowOf(window)]
}

const CachedPages = Schema.Struct({ pages: Schema.Array(Schema.Array(LocalLog)) })

/** A paged query's data: the pages and the cursor each was fetched from. */
export const pagesToCached = (data: Pick<LogPages, "pages">) => ({
	pages: data.pages,
	pageParams: [undefined, ...data.pages.slice(0, -1).map(nextCursor)],
})

export const pagesFromCached = (value: CacheValue): Option.Option<LogPages> =>
	Option.map(cachedAs(CachedPages)(value), ({ pages }) => ({
		pages,
		hasNextPage: nextCursor(pages[pages.length - 1] ?? []) !== undefined,
	}))

const CachedPatterns = Schema.Struct({ patterns: Schema.Array(LogPattern), totalSampled: Schema.Number, truncated: Schema.Boolean })

/** Legacy's `truncated` is the Model's `isTruncated`. */
export const patternsToCached = ({ isTruncated, ...rest }: LogPatterns) => ({ ...rest, truncated: isTruncated })

export const patternsFromCached = (value: CacheValue): Option.Option<LogPatterns> =>
	Option.map(cachedAs(CachedPatterns)(value), ({ truncated, ...rest }) => ({ ...rest, isTruncated: truncated }))

export const optionsFromCached = cachedAs(Schema.Array(FacetOption))

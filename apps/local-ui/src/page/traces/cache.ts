import { Option, Schema } from "effect"
import type { CacheValue, QueryKey } from "../../data/cache-store"
import { cachedAs } from "../../data/cached"
import { nextCursor } from "./fetch-traces"
import { filtersOf } from "./filters"
import { DurationStats, FacetOption, type TraceFacets, type TracePages, TraceRow } from "./model"

// The list's and the facets' cache keys and data, as the result cache keeps them.

type Window = Readonly<{ search: string; startTime: string; endTime: string }>

/** `["local", "traces", filters, boundsKey(bounds)]`. */
export const tracesKey = (window: Window): QueryKey => [
	"local",
	"traces",
	filtersOf(new URLSearchParams(window.search)),
	`${window.startTime}/${window.endTime}`,
]

/** `["local", "trace-facets", filters, boundsKey(bounds)]`. */
export const facetsKey = (window: Window): QueryKey => [
	"local",
	"trace-facets",
	filtersOf(new URLSearchParams(window.search)),
	`${window.startTime}/${window.endTime}`,
]

const CachedPages = Schema.Struct({ pages: Schema.Array(Schema.Array(TraceRow)) })

/** The paged list's data: the pages and the cursor each was fetched from. */
export const pagesToCached = (data: Pick<TracePages, "pages">) => ({
	pages: data.pages,
	pageParams: [undefined, ...data.pages.slice(0, -1).map(nextCursor)],
})

export const pagesFromCached = (value: CacheValue): Option.Option<TracePages> =>
	Option.map(cachedAs(CachedPages)(value), ({ pages }) => ({
		pages,
		hasNextPage: nextCursor(pages[pages.length - 1] ?? []) !== undefined,
	}))

const CachedFacets = Schema.Struct({
	services: Schema.Array(FacetOption),
	spanNames: Schema.Array(FacetOption),
	httpMethods: Schema.Array(FacetOption),
	httpStatusCodes: Schema.Array(FacetOption),
	deploymentEnvs: Schema.Array(FacetOption),
	namespaces: Schema.Array(FacetOption),
	errorCount: Schema.Number,
	durationStats: Schema.optionalKey(Schema.UndefinedOr(DurationStats)),
})

/** Legacy's `durationStats?: DurationStats` is the Model's Option. */
export const facetsToCached = ({ maybeDurationStats, ...rest }: TraceFacets) => ({
	...rest,
	durationStats: Option.getOrUndefined(maybeDurationStats),
})

export const facetsFromCached = (value: CacheValue): Option.Option<TraceFacets> =>
	Option.map(cachedAs(CachedFacets)(value), ({ durationStats, ...rest }) => ({
		...rest,
		maybeDurationStats: Option.fromUndefinedOr(durationStats),
	}))

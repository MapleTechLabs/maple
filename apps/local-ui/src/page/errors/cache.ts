import { Schema } from "effect"
import type { QueryKey } from "../../data/cache-store"
import { cachedAs } from "../../data/cached"
import { errorsFiltersOf } from "./command"
import { ErrorsFacets, ErrorsSummary, ErrorTrace, ErrorTypeRow } from "./fetch"

// The errors queries' keys and data, as the result cache keeps them.

type Window = Readonly<{ search: string; startTime: string; endTime: string }>

const windowOf = (window: Window) => `${window.startTime}/${window.endTime}`
const filtersFrom = (window: Window) => errorsFiltersOf(new URLSearchParams(window.search))

/** `["local", "errors", part, filters, boundsKey]` for the summary, the types and the facets. */
export const errorsKey = (part: "summary" | "by-type" | "facets", window: Window): QueryKey => [
	"local",
	"errors",
	part,
	filtersFrom(window),
	windowOf(window),
]

/** `["local", "errors", "traces", fingerprintHash, rootOnly, service, env, boundsKey]`. */
export const tracesKey = (fingerprintHash: string, window: Window): QueryKey => {
	const filters = filtersFrom(window)
	return ["local", "errors", "traces", fingerprintHash, filters.rootOnly, filters.service, filters.env, windowOf(window)]
}

export const summaryFromCached = cachedAs(Schema.NullOr(ErrorsSummary))
export const byTypeFromCached = cachedAs(Schema.Array(ErrorTypeRow))
export const facetsFromCached = cachedAs(ErrorsFacets)
export const tracesFromCached = cachedAs(Schema.Array(ErrorTrace))

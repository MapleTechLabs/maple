import { Option, Schema } from "effect"
import type { CacheValue, QueryKey } from "../../data/cache-store"
import { cachedAs } from "../../data/cached"
import { filtersOf, nextCursor } from "./fetch"
import { SessionFacets, type SessionPages, SessionRow } from "./model"

// `useLocalSessions` / `useLocalSessionFacets` keys and data, as the result cache keeps them.

type Window = Readonly<{ search: string; startTime: string; endTime: string }>

const keyFor = (name: string, window: Window): QueryKey => [
	"local",
	name,
	filtersOf(new URLSearchParams(window.search)),
	`${window.startTime}/${window.endTime}`,
]

/** `["local", "sessions", filters, boundsKey]`. */
export const sessionsKey = (window: Window) => keyFor("sessions", window)
/** `["local", "session-facets", filters, boundsKey]`. */
export const facetsKey = (window: Window) => keyFor("session-facets", window)

const CachedPages = Schema.Struct({ pages: Schema.Array(Schema.Array(SessionRow)) })

/** `useInfiniteQuery`'s data: the pages and the cursor each was fetched from. */
export const pagesToCached = (data: Pick<SessionPages, "pages">) => ({
	pages: data.pages,
	pageParams: [undefined, ...data.pages.slice(0, -1).map(nextCursor)],
})

export const pagesFromCached = (value: CacheValue): Option.Option<SessionPages> =>
	Option.map(cachedAs(CachedPages)(value), ({ pages }) => ({
		pages,
		hasNextPage: nextCursor(pages[pages.length - 1] ?? []) !== undefined,
	}))

export const facetsFromCached = cachedAs(SessionFacets)

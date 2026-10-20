import { isRangeKey } from "../lib/time"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { LocalEnv } from "../env"
import type { TimeFormat } from "./kit/local-time"
import { type Location, queryOf } from "../route"

/**
 * What every page reads from the root: where the server is, the fragment it was opened on and
 * the viewer's remembered range. Never copied into a page Model.
 */
export type PageContext = Readonly<{
	env: LocalEnv
	location: Location
	rememberedRange: string
	/** The locale and zone timestamps render in. */
	timeFormat: TimeFormat
	/** In-app history exists, so a detail page's Back steps back instead of opening the list. */
	canGoBack: boolean
}>

/** `rangeFromQuery`: the hash's own `range`, else the viewer's last pick. */
export const rangeOf = (context: PageContext): string => {
	const fromUrl = queryOf(context.location).get("range")
	return isRangeKey(fromUrl) ? fromUrl : context.rememberedRange
}

/** A page never touches the URL or the root; it asks with one of these. */
export const PageOutMessage = defineMessageUnion({
	/** `navigate(path, query, { replace })`. */
	RequestedNavigation: { hash: Schema.String, isReplace: Schema.Boolean },
	/** `goBack(listPath, query)`: history back when in-app history exists, else to the list. */
	RequestedBack: { fallbackHash: Schema.String },
	/** `setRange`: remember the pick for pages opened without one, then navigate. */
	RememberedRange: { range: Schema.String, hash: Schema.String },
	/** A `SignalEmptyState` is on screen: `useSignalPresence` reads (or reuses) the shared result. */
	RequestedSignalPresence: {},
	/**
	 * Refresh refetched the page in place (`invalidateQueries(["local"])`): the root re-probes the
	 * server and marks the signal presence stale, so the next empty state reads it again.
	 */
	RefetchedInPlace: {},
	/** `PageShell`'s Filters button below `md`: the root opens the drawer around the page's rail. */
	RequestedFilterDrawer: {},
})
export type PageOutMessage = typeof PageOutMessage.Type

export type ParamUpdates = Readonly<Record<string, string | null | undefined>>

/** `setParams` (lib/router.ts `useQueryParams`): same path, keys set or (empty) removed. */
export const withParams = (location: Location, updates: ParamUpdates): string => {
	const next = queryOf(location)
	Object.entries(updates).forEach(([key, value]) => {
		if (value === null || value === undefined || value === "") next.delete(key)
		else next.set(key, value)
	})
	const search = next.toString()
	return `#${location.path}${search ? `?${search}` : ""}`
}

/** A filter tweak: the same page with new params, replacing the history entry. */
export const replaceParams = (location: Location, updates: ParamUpdates): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ hash: withParams(location, updates), isReplace: true })

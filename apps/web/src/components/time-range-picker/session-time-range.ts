import type { AnyRouter, SearchMiddleware } from "@tanstack/react-router"

import { sessionTimeRangeAtomFor, type SessionTimeRange } from "@/atoms/session-time-range-atoms"
import { appRegistry } from "@/lib/registry"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"
import { isTimeRangeWithin, relativeToAbsolute } from "@/lib/time-utils"

import type { TimeRangeSearch } from "./search"

// `typeof` rather than truthiness: a history pop or a hand-edited URL reaches
// here unvalidated, and TanStack JSON-parses values, so `?timePreset=123` is a
// number that must neither be remembered nor re-injected elsewhere.
const isSet = (value: unknown): value is string => typeof value === "string" && value !== ""

/** The search names a window, or part of one — nothing should be added to it. */
function namesTimeRange(search: TimeRangeSearch): boolean {
	return isSet(search.timePreset) || isSet(search.startTime) || isSet(search.endTime)
}

/** A complete window: a preset, or both absolute bounds. Only these are remembered. */
function isCompleteTimeRange(
	search: TimeRangeSearch,
): search is { timePreset: string } | { startTime: string; endTime: string } {
	return isSet(search.timePreset) || (isSet(search.startTime) && isSet(search.endTime))
}

// The widest standard preset is "1mo"; 32 days covers any calendar month.
const DEFAULT_MAX_RANGE_SECONDS = 32 * 24 * 60 * 60

function isWithin(
	stored: { timePreset: string } | { startTime: string; endTime: string },
	maxRangeSeconds: number,
) {
	const range = "timePreset" in stored ? relativeToAbsolute(stored.timePreset) : stored
	return range !== null && isTimeRangeWithin(range, maxRangeSeconds)
}

/**
 * Search middleware for every route that spreads `TimeRangeSearchFields`: a
 * navigation that names no window gets the one the user last chose in this
 * tab (see `persistSessionTimeRange`). A navigation that does name one — the
 * picker, a chart brush, a "view logs for this trace" link — wins, and then
 * becomes the remembered window once it lands. A remembered window wider than
 * `maxRangeSeconds` — a year picked on Services, then a visit to Logs — is
 * ignored so the page opens on its own default; pass the same ceiling the
 * page hands its picker.
 *
 * Runs on `buildLocation`, so links and preloads see the same URL the
 * navigation will produce; the loader's `deps` are right the first time. The
 * read is a bare, synchronous `registry.get`: `Atom.kvs` in sync mode settles
 * inline because the storage layer is synchronous, and falls back to `{}` if
 * that ever stops being true — the window would then silently stop sticking.
 */
export function sessionTimeRangeSearchMiddleware<T extends TimeRangeSearch>(options?: {
	maxRangeSeconds?: number
}): SearchMiddleware<T> {
	const maxRangeSeconds = options?.maxRangeSeconds ?? DEFAULT_MAX_RANGE_SECONDS
	return ({ search, next }) => {
		const result = next(search)
		if (namesTimeRange(result)) return result
		const stored = appRegistry.get(sessionTimeRangeAtomFor(getActiveOrgId()))
		if (!isCompleteTimeRange(stored) || !isWithin(stored, maxRangeSeconds)) return result
		return { ...result, ...stored }
	}
}

/**
 * Records the window a resolved location carries into the per-org session
 * atom. A location without one — a dashboard, a settings page — leaves the
 * memory as it was, so the next time-filtered page still opens on it.
 */
export function persistSessionTimeRange(search: TimeRangeSearch) {
	const orgId = getActiveOrgId()
	if (!orgId || !isCompleteTimeRange(search)) return
	// A hand-edited pair — a bad timestamp, an end before its start — must not
	// replace a good window with one the middleware will only reject.
	if (!isWithin(search, Number.POSITIVE_INFINITY)) return
	const value: SessionTimeRange =
		"timePreset" in search
			? { timePreset: search.timePreset }
			: { startTime: search.startTime, endTime: search.endTime }
	appRegistry.set(sessionTimeRangeAtomFor(orgId), value)
}

/** Persist after every navigation settles, including the first load. */
export function subscribeSessionTimeRange(router: AnyRouter) {
	return router.subscribe("onResolved", ({ toLocation }) => {
		persistSessionTimeRange(toLocation.search as TimeRangeSearch)
	})
}

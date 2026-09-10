import type { AnyRouter, SearchMiddleware } from "@tanstack/react-router"

import { sessionTimeRangeAtomFor, type SessionTimeRange } from "@/atoms/session-time-range-atoms"
import { appRegistry } from "@/lib/registry"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"

import type { TimeRangeSearch } from "./search"

function hasTimeRangeSearch(search: TimeRangeSearch): boolean {
	return Boolean(search.timePreset || (search.startTime && search.endTime))
}

/**
 * Search middleware for every route that spreads `TimeRangeSearchFields`: a
 * navigation that names no window gets the one the user last chose in this
 * tab (see `persistSessionTimeRange`). A navigation that does name one — the
 * picker, a chart brush, a "view logs for this trace" link — wins, and then
 * becomes the remembered window once it lands.
 *
 * Runs on `buildLocation`, so links and preloads see the same URL the
 * navigation will produce; the loader's `deps` are right the first time.
 */
export function sessionTimeRangeSearchMiddleware<T extends TimeRangeSearch>({
	search,
	next,
}: Parameters<SearchMiddleware<T>>[0]): T {
	const result = next(search)
	if (hasTimeRangeSearch(result)) return result
	const stored = appRegistry.get(sessionTimeRangeAtomFor(getActiveOrgId()))
	if (!hasTimeRangeSearch(stored)) return result
	return { ...result, ...stored }
}

/**
 * Records the window a resolved location carries into the per-org session
 * atom. A location without one — a dashboard, a settings page — leaves the
 * memory as it was, so the next time-filtered page still opens on it.
 */
export function persistSessionTimeRange(search: TimeRangeSearch) {
	const orgId = getActiveOrgId()
	if (!orgId || !hasTimeRangeSearch(search)) return
	const value: SessionTimeRange = search.timePreset
		? { timePreset: search.timePreset }
		: { startTime: search.startTime!, endTime: search.endTime! }
	appRegistry.set(sessionTimeRangeAtomFor(orgId), value)
}

/** Persist after every navigation settles, including the first load. */
export function subscribeSessionTimeRange(router: AnyRouter) {
	return router.subscribe("onResolved", ({ toLocation }) => {
		persistSessionTimeRange(toLocation.search as TimeRangeSearch)
	})
}

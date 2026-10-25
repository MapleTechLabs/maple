import type { RequestMode } from "../../data/keyed"

/**
 * `useEffectiveTimeRange` + `useRefreshableAtomValue` for a page's `routeChanged`: the window is
 * re-resolved only when its own fields moved, and only Reload revalidates unchanged keys.
 * Every other URL change (a tile, a tab, a filter outside the window) requests in `Load`.
 */

/** The search fields that decide a page's window. */
export interface WindowFields {
	readonly startTime?: string | undefined
	readonly endTime?: string | undefined
	readonly timePreset?: string | undefined
}

/** Whether a navigation moved the window: only then does `routeChanged` read the clock again. */
export const isWindowChange = (previous: WindowFields, next: WindowFields): boolean =>
	previous.startTime !== next.startTime ||
	previous.endTime !== next.endTime ||
	previous.timePreset !== next.timePreset

/** How a re-resolved window snaps: snapped before any Reload, unsnapped after (`refreshVersion`). */
export const snapModeOf = (refreshVersion: number): RequestMode => (refreshVersion === 0 ? "Load" : "Refresh")

/**
 * The step a URL change takes: re-resolve the window (`resolve`, snapping per `snapModeOf`) when it
 * moved, else request every slot under the kept window in `Load`, which starts nothing for a key
 * that did not change. The resolved window's own requests also go in `Load`: `Refresh` is Reload's.
 */
export const routeWindowStep = <R>(
	previous: WindowFields,
	next: WindowFields,
	steps: { readonly resolve: () => R; readonly requestAll: (mode: RequestMode) => R },
): R => (isWindowChange(previous, next) ? steps.resolve() : steps.requestAll("Load"))

/**
 * The `/errors` URL vocabulary and trend window, apart from the list that uses
 * them. The route's search schema is registered at startup, so anything it
 * imports ships in the startup bundle; importing these from the hub carried the
 * whole list there with them.
 */

export const HUB_VIEWS = ["open", "triage", "active", "resolved", "all"] as const
export type HubView = (typeof HUB_VIEWS)[number]

/** `last_seen` leads because it is the default: newest activity first, paged
 *  back through older issues. `volume` is the one sort only the warehouse can
 *  answer, so it is the one scoped to the time range. */
export const HUB_SORTS = ["last_seen", "volume", "severity"] as const
export type HubSort = (typeof HUB_SORTS)[number]

export const SEVERITY_FILTERS = ["all", "critical", "high", "medium", "low", "unset"] as const
export type SeverityFilter = (typeof SEVERITY_FILTERS)[number]

/**
 * How far back the trend, count and totals look. A day, because a sparkline of
 * the last twelve hours reads as silence for anything that errors nightly, and
 * a week flattens a burst into a tick. Not a URL param: the list does not
 * change with it, and a picker on a list that ignores it is what this replaced.
 */
export const ERRORS_WINDOW = "24h"

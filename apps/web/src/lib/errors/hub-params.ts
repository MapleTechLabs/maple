/**
 * The `/errors` URL vocabulary and trend window, apart from the list that uses
 * them. The route's search schema is registered at startup, so anything it
 * imports ships in the startup bundle; importing these from the hub carried the
 * whole list there with them.
 */

export const HUB_VIEWS = ["open", "closed", "all"] as const
export type HubView = (typeof HUB_VIEWS)[number]

/** Tabs the list used to have. Old links still decode and land on the tab that
 *  now holds the same issues. */
export const LEGACY_HUB_VIEWS = ["triage", "active", "resolved"] as const
export type LegacyHubView = (typeof LEGACY_HUB_VIEWS)[number]

export const hubViewOf = (view: HubView | LegacyHubView | undefined): HubView =>
	view === undefined || view === "triage" || view === "active"
		? "open"
		: view === "resolved"
			? "closed"
			: view

/** `last_seen` leads because it is the default: newest activity first, paged
 *  back through older issues. `volume` is the one sort only the warehouse can
 *  answer, so it is the one scoped to the time range. */
export const HUB_SORTS = ["last_seen", "volume", "severity"] as const
export type HubSort = (typeof HUB_SORTS)[number]

export const SEVERITY_FILTERS = ["all", "critical", "high", "medium", "low", "unset"] as const
export type SeverityFilter = (typeof SEVERITY_FILTERS)[number]

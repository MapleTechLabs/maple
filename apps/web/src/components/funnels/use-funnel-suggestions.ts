import { formatWarehouseDateTime } from "@maple/query-engine"
import type { FunnelPopulationFilterField } from "@maple/query-model"

import * as React from "react"
import { Atom, Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import {
	productEventNamesResultAtom,
	webAnalyticsBreakdownsResultAtom,
	webAnalyticsPagesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { FunnelStepSuggestion } from "./funnel-step-builder"

// What the funnel panel's inputs complete from, over one time window: the
// `track()` event names for event steps, page paths for page steps, and the
// session facets (referrer, country, UTM, …) for the population filter. One
// hook so the dashboard panel fetches exactly what the /analytics view does,
// sized the same way.

const EVENT_NAME_LIMIT = 200
const PAGE_SUGGESTION_LIMIT = 100
const FACET_LIMIT = 50

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000

function useGatedRefreshableAtomValue<A, E>(
	atom: Atom.Atom<Result.Result<A, E>>,
	enabled: boolean,
): Result.Result<A, E> {
	const idle = React.useMemo(() => Atom.make<Result.Result<A, E>>(Result.initial()), [])
	return useRefreshableAtomValue(enabled ? atom : idle)
}

export interface FunnelSuggestions {
	readonly eventNames: ReadonlyArray<FunnelStepSuggestion>
	readonly pagePaths: ReadonlyArray<FunnelStepSuggestion>
	/** Per population-filter field, the values seen in the window. */
	readonly facets: Partial<Record<FunnelPopulationFilterField, string[]>>
}

/**
 * Suggestions over `window`, or the last seven days when the caller has no
 * resolved range yet. A fresh org's panel shows none and the inputs stay
 * free-text — a funnel is often built for an event that has not fired yet.
 */
export function useFunnelSuggestions(
	window: { startTime: string; endTime: string } | undefined,
	options: { enabled?: boolean } = {},
): FunnelSuggestions {
	const enabled = options.enabled ?? true
	const startTime = window?.startTime ?? formatWarehouseDateTime(Date.now() - SEVEN_DAYS_MS)
	const endTime = window?.endTime ?? formatWarehouseDateTime(Date.now())

	// `enabled: false` reads an idle atom so a builder with no product-event
	// query never pays for the three lookups.
	const eventNamesResult = useGatedRefreshableAtomValue(
		productEventNamesResultAtom({ data: { startTime, endTime, limit: EVENT_NAME_LIMIT } }),
		enabled,
	)
	const pagesResult = useGatedRefreshableAtomValue(
		webAnalyticsPagesResultAtom({ data: { startTime, endTime, limit: PAGE_SUGGESTION_LIMIT } }),
		enabled,
	)
	const facetsResult = useGatedRefreshableAtomValue(
		webAnalyticsBreakdownsResultAtom({ data: { startTime, endTime, limitPerDimension: FACET_LIMIT } }),
		enabled,
	)

	const eventNames = Result.builder(eventNamesResult)
		.onSuccess((rows) =>
			// The picker lists `track()` events; page views are the Page step's business.
			rows.data
				.filter((row) => row.kind !== "navigation")
				.map((row) => ({ name: row.eventName, count: row.count })),
		)
		.orElse(() => [])
	const pagePaths = Result.builder(pagesResult)
		.onSuccess((rows) => rows.data.map((page) => ({ name: page.pagePath, count: page.pageViews })))
		.orElse(() => [])
	const facets = Result.builder(facetsResult)
		.onSuccess((rows): FunnelSuggestions["facets"] => {
			const names = (facet: ReadonlyArray<{ name: string }>) =>
				facet.map((row) => row.name).filter(Boolean)
			return {
				referrerHost: names(rows.referrerHosts),
				country: names(rows.countries),
				deviceType: names(rows.deviceTypes),
				browserName: names(rows.browsers),
				osName: names(rows.operatingSystems),
				language: names(rows.languages),
				utmSource: names(rows.utmSources),
				utmMedium: names(rows.utmMediums),
				utmCampaign: names(rows.utmCampaigns),
				pagePath: names(rows.entryPaths),
			}
		})
		.orElse((): FunnelSuggestions["facets"] => ({}))

	return { eventNames, pagePaths, facets }
}

import { getProductEventNames } from "@maple/web-data/warehouse/product-events"
import { getWebAnalyticsBreakdowns, getWebAnalyticsPages } from "@maple/web-data/warehouse/web-analytics"
import { Effect, Schema } from "effect"
import type { TimeWindow } from "../../../data/time-range"

// `useFunnelSuggestions` (components/funnels/use-funnel-suggestions.ts): what the funnel and paths
// panels' inputs complete from, over the preview's window.

/** One suggestion: an event name or page path with its count, or a facet value under its field. */
export const Suggestion = Schema.Struct({
	name: Schema.String,
	count: Schema.NullOr(Schema.Number),
	field: Schema.NullOr(Schema.String),
})
export type Suggestion = typeof Suggestion.Type

export const SuggestionLookup = Schema.Literals(["eventNames", "pagePaths", "facets"])
export type SuggestionLookup = typeof SuggestionLookup.Type

export const SUGGESTION_LOOKUPS: ReadonlyArray<SuggestionLookup> = SuggestionLookup.literals

const EVENT_NAME_LIMIT = 200
const PAGE_SUGGESTION_LIMIT = 100
const FACET_LIMIT = 50

/** The operation and input a lookup is keyed on, as legacy's atom family keys it. */
export const suggestionRequestOf = (lookup: SuggestionLookup, window: TimeWindow) => {
	switch (lookup) {
		case "eventNames":
			return { operation: "getProductEventNames", data: { ...window, limit: EVENT_NAME_LIMIT } }
		case "pagePaths":
			return { operation: "getWebAnalyticsPages", data: { ...window, limit: PAGE_SUGGESTION_LIMIT } }
		case "facets":
			return {
				operation: "getWebAnalyticsBreakdowns",
				data: { ...window, limitPerDimension: FACET_LIMIT },
			}
	}
}

const facet = (field: string, rows: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<Suggestion> =>
	rows.flatMap((row) => (row.name === "" ? [] : [{ name: row.name, count: null, field }]))

export const fetchSuggestions = (lookup: SuggestionLookup, window: TimeWindow) => {
	switch (lookup) {
		case "eventNames":
			// The picker lists `track()` events; page views are the Page step's business.
			return Effect.map(
				getProductEventNames({ data: { ...window, limit: EVENT_NAME_LIMIT } }),
				(rows) =>
					rows.data.flatMap((row) =>
						row.kind === "navigation"
							? []
							: [{ name: row.eventName, count: row.count, field: null }],
					),
			)
		case "pagePaths":
			return Effect.map(
				getWebAnalyticsPages({ data: { ...window, limit: PAGE_SUGGESTION_LIMIT } }),
				(rows) =>
					rows.data.map((page) => ({ name: page.pagePath, count: page.pageViews, field: null })),
			)
		case "facets":
			return Effect.map(
				getWebAnalyticsBreakdowns({ data: { ...window, limitPerDimension: FACET_LIMIT } }),
				(rows): ReadonlyArray<Suggestion> => [
					...facet("referrerHost", rows.referrerHosts),
					...facet("country", rows.countries),
					...facet("deviceType", rows.deviceTypes),
					...facet("browserName", rows.browsers),
					...facet("osName", rows.operatingSystems),
					...facet("language", rows.languages),
					...facet("utmSource", rows.utmSources),
					...facet("utmMedium", rows.utmMediums),
					...facet("utmCampaign", rows.utmCampaigns),
					...facet("pagePath", rows.entryPaths),
				],
			)
	}
}

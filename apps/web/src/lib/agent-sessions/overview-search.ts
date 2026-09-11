// The URL is the whole state of `/agent-sessions/overview`. Every control —
// the six dimension selects, the two toggles, a breakdown row, a mover line —
// writes a search param and reads it back, so a link carries exactly the board
// someone was looking at and Back undoes one decision at a time.
//
// Declared here rather than in the route file because the hook, the view and
// the lab all need the decoded shape, and only the route needs the schema.

import { Schema } from "effect"

import type { AiOverviewDimension } from "@maple/domain/http"
import type { AgentSessionsSearchState } from "@/components/agent-sessions/agent-sessions-filter-inputs"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { BooleanFromStringParam } from "@/lib/search-params"

const BooleanParam = Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam]))

/**
 * The six dimensions the page groups and filters by, in the order the
 * breakdown tabs show them.
 *
 * `framework` is the page's word for what the warehouse calls a vendor — the
 * SDK or gateway that produced the spans. The URL key and the dimension id are
 * the same string on purpose; {@link overviewApiDimension} is the one place
 * the rename happens.
 */
export const OVERVIEW_DIMENSIONS = ["model", "agent", "service", "framework", "environment", "tool"] as const
export type OverviewDimension = (typeof OVERVIEW_DIMENSIONS)[number]

/** The dimension as the breakdown endpoint spells it. */
export function overviewApiDimension(dimension: OverviewDimension): AiOverviewDimension {
	return dimension === "framework" ? "vendor" : dimension
}

/**
 * Spread into the route's own `Schema.Struct`, ahead of `TimeRangeSearchFields`.
 *
 * `Schema.optional` throughout (not `optionalKey`) for the reason the
 * time-range fields give: TanStack Router hands back keys that are
 * present-but-`undefined`, and clearing a filter writes `undefined` explicitly.
 *
 * One value per dimension, not an array: this page is read by narrowing to one
 * thing at a time, and a row click that appended to a set would need a second
 * gesture to mean "only this".
 */
export const OverviewSearchFields = {
	/** The SDK or gateway, as the gateway stamps it (e.g. `eve`), not a label. */
	framework: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.String),
	tool: Schema.optional(Schema.String),
	/** Sessions with at least one failed span. */
	hasErrors: BooleanParam,
	/** The previous-period comparison. On unless the URL says `false`. */
	compare: BooleanParam,
}

export const AgentOverviewSearch = Schema.Struct(OverviewSearchFields)
export type AgentOverviewSearch = Schema.Schema.Type<typeof AgentOverviewSearch>

/** Wide enough that a nightly agent shows up at all. */
export const AGENT_OVERVIEW_DEFAULT_PRESET = "7d"

/**
 * What the page calls the window it is showing — `7d`, `24h`, `45m`.
 *
 * A preset names itself. An absolute range has no preset, and the default above
 * does not name it either: the resolver hands a start/end pair straight back
 * and never looks at the default, so a two-hour range picked by hand would
 * otherwise be labelled "prev 7d". It is named after its own length instead, to
 * the nearest whole unit.
 */
export function overviewWindowLabel(search: TimeRangeSearch, windowMs: number): string {
	if (search.timePreset !== undefined) return search.timePreset
	if (search.startTime === undefined || search.endTime === undefined) {
		return AGENT_OVERVIEW_DEFAULT_PRESET
	}
	const minutes = Math.max(1, Math.round(windowMs / 60_000))
	if (minutes < 60) return `${minutes}m`
	const hours = Math.round(minutes / 60)
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** The value in force for one dimension, or nothing. */
export const selectedDimensionValue = (
	search: AgentOverviewSearch,
	dimension: OverviewDimension,
): string | undefined => search[dimension]

/** The comparison is on by default, so only `compare=false` turns it off. */
export const compareEnabled = (search: AgentOverviewSearch): boolean => search.compare !== false

export const failingOnly = (search: AgentOverviewSearch): boolean => search.hasErrors === true

/** One option in a dimension select, with the sessions behind it. */
export interface OverviewFacetOption {
	readonly name: string
	readonly count: number
}

/** The window's facet values per dimension, unfiltered — picking one model must
 *  not erase the others from the select. */
export type OverviewFacets = Record<OverviewDimension, ReadonlyArray<OverviewFacetOption>>

export const EMPTY_OVERVIEW_FACETS = {
	model: [],
	agent: [],
	service: [],
	framework: [],
	environment: [],
	tool: [],
} satisfies OverviewFacets

export interface OverviewFilterChip {
	readonly dimension: OverviewDimension
	readonly value: string
}

/** The active dimension filters, in the dimensions' own order — the scope row. */
export function activeOverviewFilters(search: AgentOverviewSearch): ReadonlyArray<OverviewFilterChip> {
	return OVERVIEW_DIMENSIONS.flatMap((dimension) => {
		const value = search[dimension]
		return value === undefined ? [] : [{ dimension, value }]
	})
}

/** The patch "Clear all" applies: every dimension filter off, the toggles kept. */
export function clearOverviewFilters(): Partial<AgentOverviewSearch> {
	return {
		model: undefined,
		agent: undefined,
		service: undefined,
		framework: undefined,
		environment: undefined,
		tool: undefined,
	}
}

/**
 * The patch a breakdown row or a mover line applies: pick this key, or clear
 * the dimension when it is already the selected one.
 *
 * `''` is a real breakdown key — a span that carries no value for the dimension
 * — but the selection contract has no spelling for "the unnamed one", so a row
 * under it clears the dimension rather than selecting nothing.
 */
export function toggleOverviewFilter(
	search: AgentOverviewSearch,
	dimension: OverviewDimension,
	key: string,
): Partial<AgentOverviewSearch> {
	return overviewFilterPatch(dimension, key === "" || search[dimension] === key ? undefined : key)
}

/**
 * The patch that sets one dimension.
 *
 * Written out rather than built from a computed key: a computed key widens the
 * patch to an open dictionary, and the whole point of the patch type is that
 * only a real search field can reach the URL.
 */
export function overviewFilterPatch(
	dimension: OverviewDimension,
	value: string | undefined,
): Partial<AgentOverviewSearch> {
	switch (dimension) {
		case "model":
			return { model: value }
		case "agent":
			return { agent: value }
		case "service":
			return { service: value }
		case "framework":
			return { framework: value }
		case "environment":
			return { environment: value }
		case "tool":
			return { tool: value }
	}
}

/**
 * What travels from this page into the Sessions list.
 *
 * The list filters by the same six dimensions under array-valued keys, so a
 * single value becomes a one-element array. The window does NOT travel: the
 * list has no picker and reads a rolling week of its own, and a window param it
 * does not validate is dropped by the router rather than honoured.
 */
export function sessionsLinkSearch(
	search: AgentOverviewSearch,
	options?: { hasErrors?: boolean },
): AgentSessionsSearchState {
	const one = (value: string | undefined) => (value === undefined ? undefined : [value])
	const errors = options?.hasErrors ?? search.hasErrors === true
	return {
		vendors: one(search.framework),
		services: one(search.service),
		environments: one(search.environment),
		models: one(search.model),
		agents: one(search.agent),
		tools: one(search.tool),
		hasErrors: errors ? true : undefined,
	}
}

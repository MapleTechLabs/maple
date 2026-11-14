import {
	DEFAULT_PATHS_BRANCHES,
	DEFAULT_PATHS_DEPTH,
	FUNNEL_BREAKDOWN_MAX_LIMIT,
	FUNNEL_POPULATION_FILTER_FIELDS,
	type FunnelBreakdownBy,
	type FunnelKeyBy,
	type FunnelPopulationFilters,
	type FunnelStep,
	type FunnelVariant,
	PATHS_MAX_BRANCHES,
	PATHS_MAX_DEPTH,
	type PathsAnchor,
	type PathsDirection,
	type ProductEventsFunnelWidgetParams,
	type ProductEventsPathsWidgetParams,
} from "@maple/query-model"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import {
	completedSteps,
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
} from "../dashboards/kit/funnel-definition"
import type { StepDraft } from "../kit/funnel-steps"
import type { ProductAnalyticsSearch } from "../../route/search"

// What the URL says: the tab, the population filters, and the funnel and paths definitions.

export type Search = typeof ProductAnalyticsSearch.Type

export const TABS = ["events", "funnels", "paths"] as const
export type Tab = (typeof TABS)[number]

export const tabOf = (search: Search): Tab =>
	Option.getOrElse(
		Arr.findFirst(TABS, (tab) => tab === search.tab),
		(): Tab => "events",
	)

/** The session filters every read on the page takes, unset ones left out. */
export const populationOf = (search: Search): FunnelPopulationFilters =>
	Rec.fromEntries(
		Arr.flatMap(FUNNEL_POPULATION_FILTER_FIELDS, (field) =>
			search[field] === undefined ? [] : [[field, search[field]] as const],
		),
	)

export type FunnelDefinition = Readonly<{
	steps: ReadonlyArray<FunnelStep>
	keyBy: FunnelKeyBy
	windowSeconds: number
	variant: FunnelVariant
	breakdownBy: FunnelBreakdownBy | undefined
}>

export const funnelOf = (search: Search): FunnelDefinition => ({
	steps: search.steps ?? [],
	keyBy: search.keyBy ?? DEFAULT_FUNNEL_KEY_BY,
	windowSeconds:
		search.within !== undefined && Number.isFinite(search.within) && search.within > 0
			? search.within
			: DEFAULT_FUNNEL_WINDOW_SECONDS,
	variant: search.view ?? "dropoff",
	breakdownBy: search.breakdown,
})

/**
 * The funnel's widget params, or `null` until a step has something to match on. Both views show
 * the steps table, so the time between steps and the leavers are always asked for.
 */
export const funnelParamsOf = (search: Search): ProductEventsFunnelWidgetParams | null => {
	const funnel = funnelOf(search)
	const steps = Arr.map(completedSteps(funnel.steps), trimmed)
	if (steps.length === 0) return null
	return {
		...populationOf(search),
		steps,
		keyBy: funnel.keyBy,
		windowSeconds: funnel.windowSeconds,
		details: true,
	}
}

/** The same funnel with counts only: what the previous period is compared on. */
export const funnelCountsParamsOf = (search: Search): ProductEventsFunnelWidgetParams | null => {
	const params = funnelParamsOf(search)
	return params === null ? null : { ...params, details: false }
}

/** The funnel split by its breakdown, as many groups as the query answers; `null` without one. */
export const funnelBreakdownParamsOf = (search: Search): ProductEventsFunnelWidgetParams | null => {
	const params = funnelCountsParamsOf(search)
	const breakdownBy = funnelOf(search).breakdownBy
	if (params === null || breakdownBy === undefined) return null
	return { ...params, breakdownBy, breakdownLimit: FUNNEL_BREAKDOWN_MAX_LIMIT }
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
	value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(1, Math.round(value)))

export type PathsDefinition = Readonly<{
	anchor: PathsAnchor
	direction: PathsDirection
	depth: number
	branches: number
}>

export const pathsOf = (search: Search): PathsDefinition => ({
	anchor: search.anchor ?? { kind: "event", eventName: "" },
	direction: search.direction ?? "after",
	depth: clamp(search.depth, DEFAULT_PATHS_DEPTH, PATHS_MAX_DEPTH),
	branches: clamp(search.branches, DEFAULT_PATHS_BRANCHES, PATHS_MAX_BRANCHES),
})

/** The event or page an anchor names, trimmed; `""` while it names nothing. */
export const anchorNameOf = (anchor: PathsAnchor): string =>
	Str.trim(anchor.kind === "event" ? anchor.eventName : anchor.pagePath)

/** The paths widget params, or `null` until the anchor names an event or a page. */
export const pathsParamsOf = (search: Search): ProductEventsPathsWidgetParams | null => {
	const paths = pathsOf(search)
	if (anchorNameOf(paths.anchor) === "") return null
	return {
		...populationOf(search),
		anchor: trimmed(paths.anchor),
		direction: paths.direction,
		depth: paths.depth,
		branches: paths.branches,
	}
}

/** A step as the query matches it: names typed with stray spaces still find their events. */
const trimmed = <S extends FunnelStep>(step: S): S => {
	switch (step.kind) {
		case "event":
			return { ...step, eventName: Str.trim(step.eventName) }
		case "page":
			return { ...step, pagePath: Str.trim(step.pagePath) }
		case "session":
			return { ...step, value: Str.trim(step.value) }
	}
}

/** A draft step as the URL keeps it: no typed attribute filter (this page offers none). */
export const toFunnelStep = (draft: StepDraft): FunnelStep => {
	if (draft.kind !== "event") return draft
	const { filterClause: _filterClause, ...step } = draft
	return step
}

/** The paths anchor of a draft; a session step has no place in a sequence. */
export const toAnchor = (draft: StepDraft): PathsAnchor => {
	if (draft.kind === "page") return draft
	if (draft.kind === "session") return { kind: "event", eventName: "" }
	const { filterClause: _filterClause, ...step } = draft
	return step
}

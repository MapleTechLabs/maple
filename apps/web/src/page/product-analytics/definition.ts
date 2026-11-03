import {
	DEFAULT_PATHS_BRANCHES,
	DEFAULT_PATHS_DEPTH,
	FUNNEL_POPULATION_FILTER_FIELDS,
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
import {
	completedSteps,
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
} from "../../components/funnels/definition"
import type { StepDraft } from "../kit/funnel-steps"
import type { ProductAnalyticsSearch } from "../../route/search"

// What the URL says: the tab, the population filters, and the funnel and paths definitions.

export type Search = typeof ProductAnalyticsSearch.Type

export const TABS = ["events", "funnels", "paths"] as const
export type Tab = (typeof TABS)[number]

export const tabOf = (search: Search): Tab => TABS.find((tab) => tab === search.tab) ?? "events"

/** The session filters every read on the page takes, unset ones left out. */
export const populationOf = (search: Search): FunnelPopulationFilters =>
	Object.fromEntries(
		FUNNEL_POPULATION_FILTER_FIELDS.flatMap((field) =>
			search[field] === undefined ? [] : [[field, search[field]]],
		),
	)

export type FunnelDefinition = Readonly<{
	steps: ReadonlyArray<FunnelStep>
	keyBy: FunnelKeyBy
	windowSeconds: number
	variant: FunnelVariant
}>

export const funnelOf = (search: Search): FunnelDefinition => ({
	steps: search.steps ?? [],
	keyBy: search.keyBy ?? DEFAULT_FUNNEL_KEY_BY,
	windowSeconds:
		search.within !== undefined && Number.isFinite(search.within) && search.within > 0
			? search.within
			: DEFAULT_FUNNEL_WINDOW_SECONDS,
	variant: search.view ?? "dropoff",
})

/** The funnel's widget params, or `null` until a step has something to match on. */
export const funnelParamsOf = (search: Search): ProductEventsFunnelWidgetParams | null => {
	const funnel = funnelOf(search)
	const steps = completedSteps(funnel.steps)
	if (steps.length === 0) return null
	return {
		...populationOf(search),
		steps,
		keyBy: funnel.keyBy,
		windowSeconds: funnel.windowSeconds,
		details: funnel.variant === "dropoff",
	}
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
	(anchor.kind === "event" ? anchor.eventName : anchor.pagePath).trim()

/** The paths widget params, or `null` until the anchor names an event or a page. */
export const pathsParamsOf = (search: Search): ProductEventsPathsWidgetParams | null => {
	const paths = pathsOf(search)
	if (anchorNameOf(paths.anchor) === "") return null
	return {
		...populationOf(search),
		anchor: paths.anchor,
		direction: paths.direction,
		depth: paths.depth,
		branches: paths.branches,
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

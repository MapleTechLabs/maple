import type { DashboardDocument } from "@maple/domain/http"
import {
	DEFAULT_PATHS_BRANCHES,
	DEFAULT_PATHS_DEPTH,
	type FunnelStep,
	PATHS_MAX_BRANCHES,
	PATHS_MAX_DEPTH,
	ProductEventsFunnelWidgetParams,
	ProductEventsPathsWidgetParams,
} from "@maple/query-model"
import {
	completedSteps,
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
} from "../../../components/funnels/definition"
import {
	compileFunnelStep,
	compileFunnelSteps,
	draftFromFunnelStep,
	formatProductEventsFilterClause,
	hasProductEventsFilters,
	parseProductEventsFilterClause,
} from "../../../lib/query-builder/funnel-filters"
import {
	dataSourceEndpoint,
	dataSourceRouteParams,
	PRODUCT_EVENTS_FUNNEL_ENDPOINT,
	PRODUCT_EVENTS_PATHS_ENDPOINT,
} from "@maple/widgets/dashboard"
import { Option, Schema } from "effect"
import type { FunnelDraft, PathsDraft, StepDraft } from "./editor-state"

// The funnel's and the paths widget's editor drafts, read from a stored widget
// and checked (`validate`).

type Widget = DashboardDocument["widgets"][number]

/** `defaultFunnelDraft`: the query-set funnel, no steps, the /analytics defaults. */
export const defaultFunnelDraft = (): FunnelDraft => ({
	source: "query_set",
	steps: [],
	keyBy: DEFAULT_FUNNEL_KEY_BY,
	windowSeconds: DEFAULT_FUNNEL_WINDOW_SECONDS,
	filterClause: "",
	showStepPercent: null,
	variant: "bars",
	addOns: { keyBy: false, window: false, breakdown: false },
})

/** `DEFAULT_PATHS_DRAFT`: an empty event anchor, three steps forward, four branches. */
export const defaultPathsDraft = (): PathsDraft => ({
	anchor: { kind: "event", eventName: "" },
	direction: "after",
	depth: DEFAULT_PATHS_DEPTH,
	branches: DEFAULT_PATHS_BRANCHES,
	keyBy: DEFAULT_FUNNEL_KEY_BY,
	windowSeconds: DEFAULT_FUNNEL_WINDOW_SECONDS,
	include: "all",
	excludeText: "",
	filterClause: "",
	addOns: { keyBy: false, window: false, include: false, exclude: false },
})

const decodeFunnelParams = Schema.decodeUnknownOption(ProductEventsFunnelWidgetParams)
const decodePathsParams = Schema.decodeUnknownOption(ProductEventsPathsWidgetParams)

/** The stored route params, when the widget is fetched through the funnel or paths route. */
const funnelParamsOf = (widget: Widget) =>
	dataSourceEndpoint(widget.dataSource) === PRODUCT_EVENTS_FUNNEL_ENDPOINT
		? Option.getOrUndefined(decodeFunnelParams(dataSourceRouteParams(widget.dataSource) ?? {}))
		: undefined
const pathsParamsOf = (widget: Widget) =>
	dataSourceEndpoint(widget.dataSource) === PRODUCT_EVENTS_PATHS_ENDPOINT
		? Option.getOrUndefined(decodePathsParams(dataSourceRouteParams(widget.dataSource) ?? {}))
		: undefined

/** `funnelWidgetType.initialState`: the display is the definition's home, the route params a fallback. */
export const funnelInitialState = (widget: Widget): FunnelDraft => {
	const stored = widget.display.funnel
	const routeParams = funnelParamsOf(widget)
	const steps = stored?.steps ?? routeParams?.steps ?? []
	const keyBy = stored?.keyBy ?? routeParams?.keyBy ?? DEFAULT_FUNNEL_KEY_BY
	const windowSeconds = stored?.windowSeconds ?? routeParams?.windowSeconds ?? DEFAULT_FUNNEL_WINDOW_SECONDS
	const breakdownBy = stored?.breakdownBy ?? routeParams?.breakdownBy
	return {
		source: routeParams !== undefined || steps.length > 0 ? "product_events" : "query_set",
		steps: steps.map(draftFromFunnelStep),
		keyBy,
		windowSeconds,
		...(breakdownBy !== undefined ? { breakdownBy } : undefined),
		filterClause: formatProductEventsFilterClause(stored?.filters ?? routeParams),
		showStepPercent: stored?.showStepPercent ?? null,
		variant: stored?.variant ?? "bars",
		addOns: {
			keyBy: keyBy !== DEFAULT_FUNNEL_KEY_BY,
			window: windowSeconds !== DEFAULT_FUNNEL_WINDOW_SECONDS,
			breakdown: breakdownBy !== undefined,
		},
	}
}

/** `pathsWidgetType.initialState`. */
export const pathsInitialState = (widget: Widget): PathsDraft => {
	const stored = widget.display.paths
	const routeParams = pathsParamsOf(widget)
	const source = stored ?? routeParams
	if (source === undefined) return defaultPathsDraft()
	const keyBy = source.keyBy ?? "person"
	const windowSeconds = source.windowSeconds ?? 24 * 3600
	const include = source.include ?? "all"
	const exclude = source.exclude ?? []
	return {
		anchor: draftFromFunnelStep(source.anchor),
		direction: source.direction ?? "after",
		depth: source.depth ?? DEFAULT_PATHS_DEPTH,
		branches: source.branches ?? DEFAULT_PATHS_BRANCHES,
		keyBy,
		windowSeconds,
		include,
		excludeText: exclude.join(", "),
		filterClause: formatProductEventsFilterClause(stored?.filters ?? routeParams),
		addOns: {
			keyBy: keyBy !== "person",
			window: windowSeconds !== 24 * 3600,
			include: include !== "all",
			exclude: exclude.length > 0,
		},
	}
}

const populationFiltersOf = (filterClause: string) => {
	const parsed = parseProductEventsFilterClause(filterClause)
	return parsed.ok && hasProductEventsFilters(parsed.value) ? parsed.value : undefined
}

/** A draft step as the wire step; one whose filter does not compile is the bare step (Apply is gated). */
const compiledOrBare = (draft: StepDraft): FunnelStep => {
	const compiled = compileFunnelStep(draft)
	if (compiled.ok) return compiled.value
	if (draft.kind !== "event") return draft
	const { filterClause: _clause, ...step } = draft
	return step
}

/** `funnelDefinition`. */
export const funnelDefinitionOf = (funnel: FunnelDraft) => {
	const filters = populationFiltersOf(funnel.filterClause)
	return {
		steps: funnel.steps.map(compiledOrBare),
		keyBy: funnel.keyBy,
		windowSeconds: funnel.windowSeconds,
		...(funnel.breakdownBy !== undefined ? { breakdownBy: funnel.breakdownBy } : undefined),
		...(filters !== undefined ? { filters } : undefined),
		// "bars" is the absence of a choice, so it is not persisted.
		...(funnel.variant !== "bars" ? { variant: funnel.variant } : undefined),
	}
}

const parseExclude = (text: string): ReadonlyArray<string> =>
	text
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")

/** `pathsDefinition`: a session step cannot anchor a sequence. */
export const pathsDefinitionOf = (paths: PathsDraft) => {
	const anchor = compiledOrBare(paths.anchor)
	const filters = populationFiltersOf(paths.filterClause)
	const exclude = parseExclude(paths.excludeText)
	return {
		anchor: anchor.kind === "session" ? { kind: "event" as const, eventName: "" } : anchor,
		direction: paths.direction,
		depth: paths.depth,
		branches: paths.branches,
		keyBy: paths.keyBy,
		windowSeconds: paths.windowSeconds,
		include: paths.include,
		...(exclude.length > 0 ? { exclude } : undefined),
		...(filters !== undefined ? { filters } : undefined),
	}
}

/** `funnelWidgetType.validate` on a product-event funnel. */
export const funnelValidationError = (funnel: FunnelDraft): string | null => {
	const { steps, filterClause, windowSeconds } = funnel
	if (steps.length === 0) return "Add at least one step"
	const incomplete = steps.findIndex((step) => completedSteps([step]).length === 0)
	if (incomplete !== -1) return `Step ${incomplete + 1} needs an event name, page path or session value`
	if (steps.some((step, index) => index > 0 && step.kind === "session"))
		return "A session step is only valid as step 1"
	const compiled = compileFunnelSteps(steps)
	if (!compiled.ok) return compiled.error
	const filters = parseProductEventsFilterClause(filterClause)
	if (!filters.ok) return `Filters: ${filters.error}`
	if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return "The conversion window must be positive"
	return null
}

/** `pathsWidgetType.validate`. */
export const pathsValidationError = (paths: PathsDraft): string | null => {
	const { anchor, filterClause, windowSeconds, depth, branches } = paths
	if (completedSteps([anchor]).length === 0) return "The anchor needs an event name or page path"
	const compiled = compileFunnelStep(anchor)
	if (!compiled.ok) return compiled.error
	const filters = parseProductEventsFilterClause(filterClause)
	if (!filters.ok) return `Filters: ${filters.error}`
	if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return "The window must be positive"
	if (!Number.isInteger(depth) || depth < 1 || depth > PATHS_MAX_DEPTH)
		return `Steps must be between 1 and ${PATHS_MAX_DEPTH}`
	if (!Number.isInteger(branches) || branches < 1 || branches > PATHS_MAX_BRANCHES)
		return `Branches must be between 1 and ${PATHS_MAX_BRANCHES}`
	return null
}

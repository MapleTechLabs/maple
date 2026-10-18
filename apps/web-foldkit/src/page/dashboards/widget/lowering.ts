import { type DashboardDocument, WIDGET_TYPES } from "@maple/domain/http"
import { buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import { dataSourceQuerySet, makeQueryDataSource, makeStaticDataSource } from "@maple/widgets/dashboard"
import { fromPanelType, toPanelType } from "../kit/chart-registry"
import {
	deriveDefaultWidgetTitle,
	hasActiveGroupBy,
	hiddenSeriesBaseNames,
	inferDefaultUnitForQueries,
	isVisibleQuery,
	loadQueryDrafts,
} from "./drafts"
import {
	type EditorState,
	type LegendPosition,
	pointsModeFromShowPoints,
	showPointsFromPointsMode,
} from "./editor-state"

// The editor state read out of a stored widget and lowered back (`toInitialState`,
// `buildWidgetDataSource`, `buildWidgetDisplay`, `validateQueries` in widget-builder-utils.ts),
// for the timeseries panels. TODO(widget-editor): the other panel types' halves.

export type Widget = DashboardDocument["widgets"][number]
type Display = Widget["display"]

/** The panel types this editor configures; the rest keep the editor read-only. */
export const isTimeseriesPanel = (state: Pick<EditorState, "visualization" | "chartId">): boolean => {
	const panel = toPanelType(state.visualization, state.chartId)
	return panel === "line" || panel === "bar" || panel === "area"
}

const legendOf = (legend: string | undefined): LegendPosition =>
	legend === "hidden" ? "hidden" : legend === "right" ? "right" : legend === "visible" ? "bottom" : "hidden"

/** `toInitialState`, normalizing the (visualization, chartId) pair through the panel type. */
export const toInitialState = (widget: Widget): EditorState => {
	const querySet = dataSourceQuerySet(widget.dataSource)
	const panel = toPanelType(widget.visualization, widget.display.chartId)
	const normalized = fromPanelType(panel, widget.display.chartId)
	const comparison = querySet?.comparison ?? {}
	const loaded = querySet === null ? null : loadQueryDrafts(querySet)
	const presentation = widget.display.chartPresentation
	return {
		visualization: normalized.visualization,
		title: widget.display.title ?? "",
		description: widget.display.description ?? "",
		timeRange: widget.timeRange ?? null,
		chartId: normalized.chartId ?? "query-builder-line",
		stacked: widget.display.stacked ?? false,
		curveType: widget.display.curveType ?? "linear",
		// TODO(widget-editor): `legacyQueryDraft` for a pre-query-builder widget's params.
		queries: loaded?.queries ?? [],
		formulas: loaded?.formulas ?? [],
		comparisonMode: comparison.mode === "previous_period" ? "previous_period" : "none",
		includePercentChange: comparison.includePercentChange ?? true,
		unit: widget.display.unit ?? inferDefaultUnitForQueries(loaded?.queries ?? []) ?? "number",
		// A pie falls back to the side table; every time series to hidden.
		legendPosition:
			presentation?.legend === undefined && panel === "pie" ? "right" : legendOf(presentation?.legend),
		seriesStatsEnabled: presentation?.seriesStats ?? false,
		pointsMode: pointsModeFromShowPoints(presentation?.showPoints),
		thresholds: (widget.display.thresholds ?? []).map(({ value, color }) => ({ value, color })),
		markdownContent: widget.display.markdown?.content ?? "",
	}
}

export const isNote = (state: Pick<EditorState, "visualization" | "chartId">): boolean =>
	toPanelType(state.visualization, state.chartId) === "markdown"

/** `timeseriesDataSource`: the query set, with hidden series dropped by the transform. */
export const buildDataSource = (state: EditorState): Widget["dataSource"] => {
	// A note never queries.
	if (isNote(state)) return makeStaticDataSource()
	const hidden = hiddenSeriesBaseNames(state.queries, state.formulas)
	const comparison = { mode: state.comparisonMode, includePercentChange: state.includePercentChange }
	const base = {
		resultShape: "timeseries" as const,
		queries: state.queries,
		formulas: state.formulas,
		comparison,
	}
	return makeQueryDataSource(
		hidden.length > 0 ? { ...base, transform: { hideSeries: { baseNames: hidden } } } : base,
	)
}

/** Display keys a panel type owns: cleared first so nothing leaks across a type switch. */
const OWNED_DISPLAY_KEYS = new Set<string>(
	Object.values(WIDGET_TYPES).flatMap((meta) => meta.ownedDisplayKeys),
)

/** `buildWidgetDisplay` with the chart panels' own keys (`extendDisplay` in types/chart.tsx). */
export const buildDisplay = (widget: Widget, state: EditorState): Display => {
	const showPoints = showPointsFromPointsMode(state.pointsMode)
	const legend = state.legendPosition === "bottom" ? "visible" : state.legendPosition
	const kept = Object.fromEntries(
		Object.entries(widget.display).filter(([key]) => !OWNED_DISPLAY_KEYS.has(key)),
	)
	const { chartId } = fromPanelType(toPanelType(state.visualization, state.chartId), state.chartId)
	const title = state.title.trim()
	const description = state.description.trim()
	// An absent preference is an `undefined` key here; the write's JSON round trip drops it.
	const base: Display = {
		...kept,
		// Query-driven widgets saved untitled get a derived title; a note has no query to derive from.
		title: title !== "" ? title : isNote(state) ? undefined : deriveDefaultWidgetTitle(state.queries),
		description: description === "" ? undefined : description,
		chartPresentation: {
			...widget.display.chartPresentation,
			legend,
			seriesStats: state.seriesStatsEnabled,
			showPoints,
		},
		chartId,
	}
	return isNote(state)
		? { ...base, markdown: { content: state.markdownContent } }
		: {
				...base,
				stacked: state.stacked,
				curveType: state.curveType,
				unit: state.unit,
				thresholds: state.thresholds.length > 0 ? state.thresholds.map((t) => ({ ...t })) : undefined,
			}
}

/** `validateQueries` for a query-builder panel: the message that blocks Apply, or `null`. */
export const validationErrorOf = (state: EditorState): string | null => {
	if (isNote(state)) return null
	const active = state.queries.filter((query) => query.enabled !== false)
	if (active.length === 0) return "Add at least one query"
	const invalid = active
		.map((query) => ({ query, built: buildTimeseriesQuerySpec(query) }))
		.find(({ built }) => built.query === null)
	if (invalid !== undefined) return `${invalid.query.name}: ${invalid.built.error ?? "invalid query"}`
	const panel = WIDGET_TYPES[toPanelType(state.visualization, state.chartId)]
	return panel.requiresGroupBy && !active.filter(isVisibleQuery).some(hasActiveGroupBy)
		? "This visualization groups data into categories — add a group-by field"
		: null
}

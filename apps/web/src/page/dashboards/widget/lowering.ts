import { type DashboardDocument, type PanelType, STAT_AGGREGATES, WIDGET_TYPES } from "@maple/domain/http"
import {
	BREAKDOWN_TAIL_LIMIT,
	buildTimeseriesQuerySpec,
	createQueryDraft,
	resetQueryForDataSource,
} from "@maple/query-engine/query-builder"
import {
	dataSourceQuerySet,
	dataSourceRouteParams,
	dataSourceTransform,
	makeProductEventsFunnelDataSource,
	makeProductEventsPathsDataSource,
	makeQueryDataSource,
	makeStaticDataSource,
} from "@maple/widgets/dashboard"
import { fromPanelType, toPanelType } from "../kit/chart-registry"
import {
	deriveDefaultWidgetTitle,
	hasActiveGroupBy,
	hiddenSeriesBaseNames,
	inferDefaultUnitForQueries,
	inferDisplayUnitForQuery,
	isVisibleQuery,
	legacyQueryDraft,
	loadQueryDrafts,
	toSeriesFieldOptions,
} from "./drafts"
import {
	type EditorState,
	type LegendPosition,
	pointsModeFromShowPoints,
	showPointsFromPointsMode,
} from "./editor-state"
import { listDataSourceOf, listDisplayOf, listInitialState } from "./lowering-list"
import {
	defaultFunnelDraft,
	defaultPathsDraft,
	funnelDefinitionOf,
	funnelInitialState,
	funnelValidationError,
	pathsDefinitionOf,
	pathsInitialState,
	pathsValidationError,
} from "./lowering-product"

// The editor state read out of a stored widget and lowered back (`toInitialState`,
// `buildWidgetDataSource`, `buildWidgetDisplay`, `validateQueries`, with each type's halves).

export type Widget = DashboardDocument["widgets"][number]
type Display = Widget["display"]
type DataSource = Widget["dataSource"]

const panelOf = (state: Pick<EditorState, "visualization" | "chartId">): PanelType =>
	toPanelType(state.visualization, state.chartId)

export const isNote = (state: Pick<EditorState, "visualization" | "chartId">): boolean =>
	panelOf(state) === "markdown"

/** `isProductEventsFunnel`: fetched from its step definition, not its query set. */
export const isProductEventsFunnel = (state: Pick<EditorState, "visualization" | "funnel">): boolean =>
	state.visualization === "funnel" && state.funnel.source === "product_events"

const legendOf = (legend: string | undefined): LegendPosition =>
	legend === "hidden" ? "hidden" : legend === "right" ? "right" : legend === "visible" ? "bottom" : "hidden"

const toStatAggregate = (value: unknown): EditorState["statAggregate"] =>
	STAT_AGGREGATES.find((candidate) => candidate === value) ?? "first"

/** `parsePositiveNumber` / `parseRowLimit` (capped at `ROW_LIMIT_MAX`). */
const parseRowLimit = (raw: string): number | undefined => {
	const parsed = Number.parseInt(raw.trim(), 10)
	return !Number.isFinite(parsed) || parsed <= 0 ? undefined : Math.min(parsed, 1000)
}

const parseFiniteNumber = (raw: string): number | undefined => {
	const trimmed = raw.trim()
	if (trimmed === "") return undefined
	const parsed = Number(trimmed)
	return Number.isFinite(parsed) ? parsed : undefined
}

/** `toInitialState`, normalizing the (visualization, chartId) pair through the panel type. */
export const toInitialState = (widget: Widget): EditorState => {
	const querySet = dataSourceQuerySet(widget.dataSource)
	const transform = dataSourceTransform(widget.dataSource)
	const panel = toPanelType(widget.visualization, widget.display.chartId)
	const normalized = fromPanelType(panel, widget.display.chartId)
	const comparison = querySet?.comparison ?? {}
	const loaded = querySet === null ? null : loadQueryDrafts(querySet)
	const presentation = widget.display.chartPresentation
	const isScalar = panel === "stat" || panel === "gauge"
	const gauge = panel === "gauge" ? widget.display.gauge : undefined
	const funnel = panel === "funnel" ? funnelInitialState(widget) : defaultFunnelDraft()
	// A list's draft query only satisfies the state shape; a product-event funnel's placeholder reads product events.
	const queries =
		panel === "list"
			? [createQueryDraft(0)]
			: loaded !== null && loaded.queries.length > 0
				? loaded.queries
				: panel === "funnel" && funnel.source === "product_events"
					? [resetQueryForDataSource(createQueryDraft(0), "product_events")]
					: // A widget from before the query builder reads its route params as query A.
						[legacyQueryDraft(dataSourceRouteParams(widget.dataSource) ?? {})]
	return {
		visualization: normalized.visualization,
		title: widget.display.title ?? "",
		description: widget.display.description ?? "",
		timeRange: widget.timeRange ?? null,
		chartId: normalized.chartId ?? "query-builder-line",
		stacked: widget.display.stacked ?? false,
		curveType: widget.display.curveType ?? "linear",
		queries,
		formulas: panel === "list" ? [] : (loaded?.formulas ?? []),
		comparisonMode: comparison.mode === "previous_period" ? "previous_period" : "none",
		includePercentChange: comparison.includePercentChange ?? true,
		unit: widget.display.unit ?? inferDefaultUnitForQueries(loaded?.queries ?? []) ?? "number",
		// A pie falls back to the side table; every time series to hidden.
		legendPosition:
			presentation?.legend === undefined && panel === "pie" ? "right" : legendOf(presentation?.legend),
		seriesStatsEnabled: presentation?.seriesStats ?? false,
		pointsMode: pointsModeFromShowPoints(presentation?.showPoints),
		thresholds: (widget.display.thresholds ?? []).map(({ value, color }) => ({ value, color })),
		statAggregate: isScalar ? toStatAggregate(transform?.reduceToValue?.aggregate) : "first",
		statValueField: isScalar ? (transform?.reduceToValue?.field ?? "") : "",
		sparklineEnabled: panel === "stat" && widget.display.sparkline?.enabled === true,
		gaugeMin: gauge?.min == null ? "" : String(gauge.min),
		gaugeMax: gauge?.max == null ? "" : String(gauge.max),
		tableLimit: panel === "table" && typeof transform?.limit === "number" ? String(transform.limit) : "",
		heatmapColorScale: panel === "heatmap" ? (widget.display.heatmap?.colorScale ?? null) : null,
		heatmapScaleType: panel === "heatmap" ? (widget.display.heatmap?.scaleType ?? "linear") : "linear",
		markdownContent: widget.display.markdown?.content ?? "",
		...listInitialState(panel === "list" ? widget : null),
		funnel,
		paths: panel === "paths" ? pathsInitialState(widget) : defaultPathsDraft(),
	}
}

/** `timeseriesDataSource`: the query set every query-driven type starts from. */
const timeseriesOf = (state: EditorState) => {
	const hidden = hiddenSeriesBaseNames(state.queries, state.formulas)
	const sharedTransform = hidden.length > 0 ? { hideSeries: { baseNames: hidden } } : undefined
	const base = makeQueryDataSource({
		resultShape: "timeseries",
		queries: state.queries,
		formulas: state.formulas,
		comparison: { mode: state.comparisonMode, includePercentChange: state.includePercentChange },
		...(sharedTransform === undefined ? undefined : { transform: sharedTransform }),
	})
	return { base, sharedTransform }
}

/** `breakdownDataSource`: one row per category; only the pie asks for its long tail. */
const breakdownOf = (state: EditorState, defaultLimit?: number): DataSource => {
	const { sharedTransform } = timeseriesOf(state)
	return makeQueryDataSource({
		resultShape: "breakdown",
		queries: state.queries.filter(isVisibleQuery),
		...(defaultLimit === undefined ? undefined : { defaultLimit }),
		...(sharedTransform === undefined ? undefined : { transform: sharedTransform }),
	})
}

/** The scalar reduction a stat and a gauge share. */
const scalarOf = (state: EditorState): DataSource => {
	const { base, sharedTransform } = timeseriesOf(state)
	const field = state.statValueField || toSeriesFieldOptions(state)[0] || "A"
	return {
		...base,
		transform: { ...sharedTransform, reduceToValue: { field, aggregate: state.statAggregate } },
	}
}

const tableOf = (state: EditorState): DataSource => {
	const { base, sharedTransform } = timeseriesOf(state)
	const limit = parseRowLimit(state.tableLimit)
	const visible = state.queries.filter(isVisibleQuery)
	if (visible.some(hasActiveGroupBy))
		return makeQueryDataSource({
			resultShape: "breakdown",
			queries: visible,
			...(limit === undefined ? undefined : { transform: { limit } }),
		})
	return limit === undefined ? base : { ...base, transform: { ...sharedTransform, limit } }
}

/** A histogram grouped is breakdown rows; ungrouped, raw values bucketized client-side. */
const histogramOf = (state: EditorState): DataSource => {
	const visible = state.queries.filter(isVisibleQuery)
	if (visible.some(hasActiveGroupBy)) return breakdownOf(state)
	const { sharedTransform } = timeseriesOf(state)
	return makeQueryDataSource({
		resultShape: "list",
		queries: visible,
		limit: parseRowLimit(state.tableLimit) ?? 200,
		...(visible[0]?.dataSource === "traces" || visible[0] === undefined
			? { columns: ["durationMs"] }
			: undefined),
		...(sharedTransform === undefined ? undefined : { transform: sharedTransform }),
	})
}

/** `buildWidgetDataSource`: each type's `buildDataSource` over the shared base. */
export const buildDataSource = (state: EditorState): DataSource => {
	switch (panelOf(state)) {
		case "markdown":
			return makeStaticDataSource()
		case "stat":
		case "gauge":
			return scalarOf(state)
		case "table":
			return tableOf(state)
		case "pie":
			return breakdownOf(state, BREAKDOWN_TAIL_LIMIT)
		case "hbar":
		case "heatmap":
			return breakdownOf(state)
		case "histogram":
			return histogramOf(state)
		case "list":
			return listDataSourceOf(state)
		case "funnel":
			return isProductEventsFunnel(state)
				? makeProductEventsFunnelDataSource(
						funnelDefinitionOf(state.funnel),
						timeseriesOf(state).sharedTransform,
					)
				: breakdownOf(state)
		case "paths":
			return makeProductEventsPathsDataSource(
				pathsDefinitionOf(state.paths),
				timeseriesOf(state).sharedTransform,
			)
		default:
			return timeseriesOf(state).base
	}
}

/** Display keys a panel type owns: cleared first so nothing leaks across a type switch. */
const OWNED_DISPLAY_KEYS = new Set<string>(
	Object.values(WIDGET_TYPES).flatMap((meta) => meta.ownedDisplayKeys),
)

const thresholdsOf = (state: EditorState) =>
	state.thresholds.length > 0 ? state.thresholds.map((threshold) => ({ ...threshold })) : undefined

/** A grouped table's columns come from its group-by; an ungrouped one infers them. */
const tableColumnsOf = (state: EditorState): Display["columns"] => {
	const grouped = state.queries.find((query) => isVisibleQuery(query) && hasActiveGroupBy(query))
	if (grouped === undefined) return undefined
	const label = grouped.groupBy.find((g) => g.trim() !== "" && g.trim().toLowerCase() !== "none") ?? "name"
	return [
		{ field: "name", header: label, align: "left" },
		{
			field: "value",
			header: grouped.aggregation,
			unit: inferDisplayUnitForQuery(grouped) ?? "number",
			align: "right",
		},
	]
}

/** `display.funnel`: the definition on a product-event funnel; only the rendering flags on a query set. */
const funnelDisplayOf = (state: EditorState): Display["funnel"] => {
	const { showStepPercent, variant } = state.funnel
	const stepPercent = showStepPercent === null ? undefined : { showStepPercent }
	if (isProductEventsFunnel(state)) {
		const definition = funnelDefinitionOf(state.funnel)
		return { ...stepPercent, ...definition, steps: [...definition.steps] }
	}
	return stepPercent !== undefined || variant !== "bars"
		? { ...stepPercent, ...(variant !== "bars" ? { variant } : undefined) }
		: undefined
}

/** Each type's `buildDisplay` additions (`extendDisplay`). */
const ownDisplayOf = (state: EditorState): Partial<Display> => {
	switch (panelOf(state)) {
		case "markdown":
			return { markdown: { content: state.markdownContent } }
		case "stat":
			return {
				unit: state.unit,
				sparkline: state.sparklineEnabled
					? { enabled: true, dataSource: timeseriesOf(state).base }
					: undefined,
				thresholds: thresholdsOf(state),
			}
		case "gauge":
			return {
				unit: state.unit,
				gauge: {
					min: parseFiniteNumber(state.gaugeMin) ?? 0,
					max: parseFiniteNumber(state.gaugeMax) ?? 100,
				},
				thresholds: thresholdsOf(state),
			}
		case "table":
			return { columns: tableColumnsOf(state) }
		case "heatmap":
			return {
				heatmap: {
					...(state.heatmapColorScale === null
						? undefined
						: { colorScale: state.heatmapColorScale }),
					scaleType: state.heatmapScaleType,
				},
			}
		case "funnel":
			return { funnel: funnelDisplayOf(state) }
		case "paths": {
			const { exclude, ...definition } = pathsDefinitionOf(state.paths)
			return {
				paths: { ...definition, ...(exclude === undefined ? undefined : { exclude: [...exclude] }) },
			}
		}
		case "pie":
		case "hbar":
		case "histogram":
			return {}
		default:
			return {
				stacked: state.stacked,
				curveType: state.curveType,
				unit: state.unit,
				thresholds: thresholdsOf(state),
			}
	}
}

/** `buildWidgetDisplay`: the shared base, then the panel type's own keys. */
export const buildDisplay = (widget: Widget, state: EditorState): Display => {
	// A list owns its whole display: nothing of the previous type survives.
	if (panelOf(state) === "list") return listDisplayOf(state)
	const showPoints = showPointsFromPointsMode(state.pointsMode)
	const legend = state.legendPosition === "bottom" ? "visible" : state.legendPosition
	const kept = Object.fromEntries(
		Object.entries(widget.display).filter(([key]) => !OWNED_DISPLAY_KEYS.has(key)),
	)
	const { chartId } = fromPanelType(panelOf(state), state.chartId)
	const title = state.title.trim()
	const description = state.description.trim()
	// An absent preference is an `undefined` key here; the write's JSON round trip drops it.
	return {
		...kept,
		// Query-driven widgets saved untitled get a derived title; notes and paths have no query to derive from.
		title:
			title !== ""
				? title
				: isNote(state) || panelOf(state) === "paths"
					? undefined
					: deriveDefaultWidgetTitle(state.queries),
		description: description === "" ? undefined : description,
		chartPresentation: {
			...widget.display.chartPresentation,
			legend,
			seriesStats: state.seriesStatsEnabled,
			showPoints,
		},
		...(chartId === undefined ? undefined : { chartId }),
		...ownDisplayOf(state),
	}
}

/** `validateQueries` for a query-builder panel: the message that blocks Apply, or `null`. */
export const validationErrorOf = (state: EditorState): string | null => {
	const panelType = panelOf(state)
	if (panelType === "paths") return pathsValidationError(state.paths)
	// A list is configured by its own panel and a note never queries: neither has a query to check.
	if (isNote(state) || panelType === "list") return null
	if (isProductEventsFunnel(state)) return funnelValidationError(state.funnel)
	const active = state.queries.filter((query) => query.enabled !== false)
	if (active.length === 0) return "Add at least one query"
	const invalid = active
		.map((query) => ({ query, built: buildTimeseriesQuerySpec(query) }))
		.find(({ built }) => built.query === null)
	if (invalid !== undefined) return `${invalid.query.name}: ${invalid.built.error ?? "invalid query"}`
	const visible = active.filter(isVisibleQuery)
	const panel = panelOf(state)
	if (WIDGET_TYPES[panel].requiresGroupBy && !visible.some(hasActiveGroupBy))
		return "This visualization groups data into categories. Add a group-by field"
	// An ungrouped histogram bucketizes a numeric column, and only traces have one.
	if (panel === "histogram" && !visible.some(hasActiveGroupBy)) {
		const unsupported = visible.find((query) => query.dataSource !== "traces")
		if (unsupported !== undefined)
			return `${unsupported.name}: a ${unsupported.dataSource} histogram needs a group-by field`
	}
	return null
}

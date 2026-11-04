import { type DashboardDocument, type PanelType, STAT_AGGREGATES, WIDGET_TYPES } from "@maple/domain/http"
import {
	BREAKDOWN_TAIL_LIMIT,
	buildTimeseriesQuerySpec,
	createQueryDraft,
	resetQueryForDataSource,
} from "@maple/query-engine/query-builder"
import {
	dataSourceQuerySet,
	dataSourceRawSql,
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
import { listDataSourceOf, listDisplayOf, listInitialState, parsePositiveNumber } from "./lowering-list"
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
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

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

/** The table's row limit input caps at this many rows. */
export const ROW_LIMIT_MAX = 1000

const parseRowLimit = (raw: string): number | undefined => {
	const parsed = parsePositiveNumber(raw)
	return parsed === undefined ? undefined : Math.min(parsed, ROW_LIMIT_MAX)
}

const parseFiniteNumber = (raw: string): number | undefined => {
	const trimmed = Str.trim(raw)
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
	const isProductFunnel = panel === "funnel" && funnel.source === "product_events"
	// A fixed-endpoint widget reads its route params as a stand-in query A.
	const isStandIn =
		panel !== "list" &&
		panel !== "markdown" &&
		panel !== "paths" &&
		!isProductFunnel &&
		(loaded === null || loaded.queries.length === 0)
	// A list's draft query only satisfies the state shape; a product-event funnel's placeholder reads product events.
	const queries =
		panel === "list"
			? [createQueryDraft(0)]
			: loaded !== null && loaded.queries.length > 0
				? loaded.queries
				: isProductFunnel
					? [resetQueryForDataSource(createQueryDraft(0), "product_events")]
					: [legacyQueryDraft(dataSourceRouteParams(widget.dataSource) ?? {})]
	return {
		visualization: normalized.visualization,
		title: widget.display.title ?? "",
		description: widget.display.description ?? "",
		timeRange: widget.timeRange ?? null,
		chartId: normalized.chartId ?? "query-builder-line",
		stacked: widget.display.stacked ?? false,
		curveType: widget.display.curveType ?? "linear",
		queries,
		keepsStoredSource: isStandIn && dataSourceRawSql(widget.dataSource) === null,
		formulas: panel === "list" ? [] : (loaded?.formulas ?? []),
		comparisonMode: comparison.mode === "previous_period" ? "previous_period" : "none",
		includePercentChange: comparison.includePercentChange ?? true,
		unit: widget.display.unit ?? inferDefaultUnitForQueries(loaded?.queries ?? []) ?? "number",
		// A pie falls back to the side table; every time series to hidden.
		legendPosition:
			presentation?.legend === undefined && panel === "pie" ? "right" : legendOf(presentation?.legend),
		seriesStatsEnabled: presentation?.seriesStats ?? false,
		pointsMode: pointsModeFromShowPoints(presentation?.showPoints),
		thresholds: Arr.map(widget.display.thresholds ?? [], ({ value, color }) => ({ value, color })),
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

type QueryCapabilities = Readonly<{ comparison: boolean; formulas: boolean }>

const NO_QUERY_CAPABILITIES: QueryCapabilities = { comparison: false, formulas: false }

/** What a panel's query set keeps when lowered: the rail offers comparison and formulas only here. */
export const queryCapabilitiesOf = (
	state: Pick<EditorState, "visualization" | "chartId" | "queries">,
): QueryCapabilities => {
	switch (panelOf(state)) {
		case "line":
		case "bar":
		case "area":
		case "stat":
		case "gauge":
			return { comparison: true, formulas: true }
		// A grouped table is breakdown rows, which carry neither.
		case "table": {
			const isGrouped = Arr.some(Arr.filter(state.queries, isVisibleQuery), hasActiveGroupBy)
			return isGrouped ? NO_QUERY_CAPABILITIES : { comparison: true, formulas: true }
		}
		default:
			return NO_QUERY_CAPABILITIES
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
		queries: Arr.filter(state.queries, isVisibleQuery),
		...(defaultLimit === undefined ? undefined : { defaultLimit }),
		...(sharedTransform === undefined ? undefined : { transform: sharedTransform }),
	})
}

/** The series a stat or gauge reduces: the picked one while it is still listed, else the first. */
export const statValueFieldOf = (state: EditorState): string => {
	const fields = toSeriesFieldOptions(state)
	return fields.includes(state.statValueField) ? state.statValueField : (fields[0] ?? "A")
}

/** The scalar reduction a stat and a gauge share. */
const scalarOf = (state: EditorState): DataSource => {
	const { base, sharedTransform } = timeseriesOf(state)
	return {
		...base,
		transform: {
			...sharedTransform,
			reduceToValue: { field: statValueFieldOf(state), aggregate: state.statAggregate },
		},
	}
}

const tableOf = (state: EditorState): DataSource => {
	const { base, sharedTransform } = timeseriesOf(state)
	const limit = parseRowLimit(state.tableLimit)
	const visible = Arr.filter(state.queries, isVisibleQuery)
	if (Arr.some(visible, hasActiveGroupBy))
		return makeQueryDataSource({
			resultShape: "breakdown",
			queries: visible,
			...(limit === undefined ? undefined : { transform: { limit } }),
		})
	return limit === undefined ? base : { ...base, transform: { ...sharedTransform, limit } }
}

/** A histogram grouped is breakdown rows; ungrouped, raw values bucketized client-side. */
const histogramOf = (state: EditorState): DataSource => {
	const visible = Arr.filter(state.queries, isVisibleQuery)
	if (Arr.some(visible, hasActiveGroupBy)) return breakdownOf(state)
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

/** A fixed endpoint's stored source, with the stat or gauge aggregate picked in the editor. */
const storedSourceOf = (widget: Widget, state: EditorState): DataSource => {
	const transform = dataSourceTransform(widget.dataSource)
	const reduce = transform?.reduceToValue
	if (reduce === undefined || !WIDGET_TYPES[panelOf(state)].isScalar) return widget.dataSource
	return {
		...widget.dataSource,
		transform: { ...transform, reduceToValue: { ...reduce, aggregate: state.statAggregate } },
	}
}

/** The builder's source: the stored one while a fixed endpoint's stand-in queries are untouched. */
export const builderDataSourceOf = (widget: Widget, state: EditorState): DataSource =>
	state.keepsStoredSource ? storedSourceOf(widget, state) : buildDataSource(state)

const encodeJsonOption = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))
const sameJson = (a: unknown, b: unknown): boolean =>
	Option.getOrNull(encodeJsonOption(a)) === Option.getOrNull(encodeJsonOption(b))

/** The stored source holds while the queries, formulas, comparison, row limit and type match the opened state. */
export const trackStoredSource = (initial: EditorState | null, after: EditorState): EditorState => {
	if (initial === null || !initial.keepsStoredSource) return after
	const keeps =
		sameJson(after.queries, initial.queries) &&
		sameJson(after.formulas, initial.formulas) &&
		after.comparisonMode === initial.comparisonMode &&
		after.tableLimit === initial.tableLimit &&
		panelOf(after) === panelOf(initial)
	return after.keepsStoredSource === keeps ? after : { ...after, keepsStoredSource: keeps }
}

/** Display keys a panel type owns: cleared first so nothing leaks across a type switch. */
const OWNED_DISPLAY_KEYS = new Set<string>(
	Arr.flatMap(Rec.values(WIDGET_TYPES), (meta) => meta.ownedDisplayKeys),
)

const thresholdsOf = (state: EditorState) =>
	state.thresholds.length > 0 ? Arr.map(state.thresholds, (threshold) => ({ ...threshold })) : undefined

/** A grouped table's columns come from its group-by; an ungrouped one infers them. */
const tableColumnsOf = (state: EditorState): Display["columns"] => {
	const grouped = state.queries.find((query) => isVisibleQuery(query) && hasActiveGroupBy(query))
	if (grouped === undefined) return undefined
	const label =
		grouped.groupBy.find((g) => Str.trim(g) !== "" && Str.toLowerCase(Str.trim(g)) !== "none") ?? "name"
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

/** A stat's trend line: the builder series, or a fixed endpoint's stored one (its stand-in queries are not its data). */
const sparklineOf = (widget: Widget, state: EditorState, isSql: boolean): Display["sparkline"] => {
	if (!state.sparklineEnabled || isSql) return undefined
	if (!state.keepsStoredSource) return { enabled: true, dataSource: timeseriesOf(state).base }
	const stored = widget.display.sparkline
	return stored?.dataSource === undefined ? undefined : { ...stored, enabled: true }
}

/** Each type's `buildDisplay` additions (`extendDisplay`); the sparkline re-runs builder queries, so SQL has none. */
const ownDisplayOf = (widget: Widget, state: EditorState, isSql: boolean): Partial<Display> => {
	switch (panelOf(state)) {
		case "markdown":
			return { markdown: { content: state.markdownContent } }
		case "stat":
			return {
				unit: state.unit,
				sparkline: sparklineOf(widget, state, isSql),
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
const displayOf = (widget: Widget, state: EditorState, isSql: boolean): Display => {
	// A list owns its whole display: nothing of the previous type survives.
	if (panelOf(state) === "list") return listDisplayOf(state)
	const showPoints = showPointsFromPointsMode(state.pointsMode)
	const legend = state.legendPosition === "bottom" ? "visible" : state.legendPosition
	const kept = Rec.fromEntries(
		Arr.filter(Object.entries(widget.display), ([key]) => !OWNED_DISPLAY_KEYS.has(key)),
	)
	const { chartId } = fromPanelType(panelOf(state), state.chartId)
	const title = Str.trim(state.title)
	const description = Str.trim(state.description)
	// An absent preference is an `undefined` key here; the write's JSON round trip drops it.
	return {
		...kept,
		// Builder widgets saved untitled get a derived title; notes, paths and SQL have no query to derive from.
		title:
			title !== ""
				? title
				: isSql || isNote(state) || panelOf(state) === "paths"
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
		...ownDisplayOf(widget, state, isSql),
	}
}

export const buildDisplay = (widget: Widget, state: EditorState): Display => displayOf(widget, state, false)

/** The display a Raw SQL source writes: no builder sparkline, no title derived from builder queries. */
export const buildSqlDisplay = (widget: Widget, state: EditorState): Display => displayOf(widget, state, true)

/** `validateQueries` for a query-builder panel: the message that blocks Apply, or `null`. */
export const validationErrorOf = (state: EditorState): string | null => {
	const panelType = panelOf(state)
	if (panelType === "paths") return pathsValidationError(state.paths)
	// A list is configured by its own panel and a note never queries: neither has a query to check.
	if (isNote(state) || panelType === "list") return null
	if (isProductEventsFunnel(state)) return funnelValidationError(state.funnel)
	const active = Arr.filter(state.queries, (query) => query.enabled !== false)
	if (active.length === 0) return "Add at least one query"
	const invalid = Arr.map(active, (query) => ({ query, built: buildTimeseriesQuerySpec(query) })).find(
		({ built }) => built.query === null,
	)
	if (invalid !== undefined) return `${invalid.query.name}: ${invalid.built.error ?? "invalid query"}`
	const visible = Arr.filter(active, isVisibleQuery)
	const panel = panelOf(state)
	if (WIDGET_TYPES[panel].requiresGroupBy && !Arr.some(visible, hasActiveGroupBy))
		return "This visualization groups data into categories. Add a group-by field"
	// An ungrouped histogram bucketizes a numeric column, and only traces have one.
	if (panel === "histogram" && !Arr.some(visible, hasActiveGroupBy)) {
		const unsupported = visible.find((query) => query.dataSource !== "traces")
		if (unsupported !== undefined)
			return `${unsupported.name}: a ${unsupported.dataSource} histogram needs a group-by field`
	}
	return null
}

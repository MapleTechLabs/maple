import {
	HEATMAP_COLOR_SCALES,
	HEATMAP_SCALE_TYPES,
	STAT_AGGREGATES,
	TimeRangeSchema,
	WIDGET_VISUALIZATIONS,
} from "@maple/domain/http"
import { QUERY_COMPARISON_MODES } from "@maple/query-model"
import { Schema } from "effect"
import { QueryDraft } from "../../kit/query-builder/draft"

// The widget editor's state (`QueryBuilderWidgetState`, apps/web/src/lib/query-builder/
// widget-builder-shared.ts), cut to what the query-builder panels and notes read.
// TODO(widget-editor): the list, funnel and paths fields.

export { QueryDraft } from "../../kit/query-builder/draft"

/** `QueryBuilderFormulaDraft`. */
export const FormulaDraft = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	expression: Schema.String,
	legend: Schema.String,
	hidden: Schema.Boolean,
})
export type FormulaDraft = typeof FormulaDraft.Type

export const LegendPosition = Schema.Literals(["bottom", "right", "hidden"])
export type LegendPosition = typeof LegendPosition.Type

export const PointsMode = Schema.Literals(["auto", "always", "never"])
export type PointsMode = typeof PointsMode.Type

export const Threshold = Schema.Struct({ value: Schema.Number, color: Schema.String })

export const EditorState = Schema.Struct({
	visualization: Schema.Literals(WIDGET_VISUALIZATIONS),
	title: Schema.String,
	description: Schema.String,
	/** The widget's own range, or `null` to follow the dashboard's. */
	timeRange: Schema.NullOr(TimeRangeSchema),
	chartId: Schema.String,
	stacked: Schema.Boolean,
	curveType: Schema.Literals(["linear", "monotone"]),
	queries: Schema.Array(QueryDraft),
	formulas: Schema.Array(FormulaDraft),
	comparisonMode: Schema.Literals(QUERY_COMPARISON_MODES),
	includePercentChange: Schema.Boolean,
	unit: Schema.String,
	legendPosition: LegendPosition,
	seriesStatsEnabled: Schema.Boolean,
	pointsMode: PointsMode,
	thresholds: Schema.Array(Threshold),
	statAggregate: Schema.Literals(STAT_AGGREGATES),
	/** The series a stat or gauge reduces; empty is the first visible series. */
	statValueField: Schema.String,
	sparklineEnabled: Schema.Boolean,
	gaugeMin: Schema.String,
	gaugeMax: Schema.String,
	tableLimit: Schema.String,
	/** `undefined` in legacy: never chosen, so Apply leaves `display.heatmap.colorScale` absent. */
	heatmapColorScale: Schema.NullOr(Schema.Literals(HEATMAP_COLOR_SCALES)),
	heatmapScaleType: Schema.Literals(HEATMAP_SCALE_TYPES),
	/** A note's body; static, it never reaches the warehouse. */
	markdownContent: Schema.String,
})
export type EditorState = typeof EditorState.Type

/** `chartPresentation.showPoints` and `PointsMode`: absent is Auto. */
export const pointsModeFromShowPoints = (showPoints: boolean | undefined): PointsMode =>
	showPoints === undefined ? "auto" : showPoints ? "always" : "never"
export const showPointsFromPointsMode = (mode: PointsMode): boolean | undefined =>
	mode === "auto" ? undefined : mode === "always"

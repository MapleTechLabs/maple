import { TimeRangeSchema, WIDGET_VISUALIZATIONS } from "@maple/domain/http"
import {
	QUERY_BUILDER_METRIC_TYPES,
	QUERY_BUILDER_SIGNAL_SOURCES,
	QUERY_COMPARISON_MODES,
	QueryBuilderAddOnsSchema,
} from "@maple/query-model"
import { Schema } from "effect"

// The widget editor's state (`QueryBuilderWidgetState`, apps/web/src/lib/query-builder/
// widget-builder-shared.ts), cut to what the timeseries panels (line, bar, area) and notes read.
// TODO(widget-editor): the stat/gauge/table/list/breakdown/funnel/paths/markdown fields.

/** `QueryBuilderQueryDraftBase`: every field filled, unlike the stored draft. */
const draftFields = {
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	hidden: Schema.Boolean,
	whereClause: Schema.String,
	aggregation: Schema.String,
	stepInterval: Schema.String,
	orderByDirection: Schema.Literals(["desc", "asc"]),
	addOns: QueryBuilderAddOnsSchema,
	groupBy: Schema.mutable(Schema.Array(Schema.String)),
	having: Schema.String,
	orderBy: Schema.String,
	limit: Schema.String,
	legend: Schema.String,
}

/** `QueryBuilderQueryDraft`. */
export const QueryDraft = Schema.Union([
	Schema.Struct({ ...draftFields, dataSource: Schema.Literal("traces") }),
	Schema.Struct({ ...draftFields, dataSource: Schema.Literal("logs") }),
	Schema.Struct({
		...draftFields,
		dataSource: Schema.Literal("metrics"),
		signalSource: Schema.Literals(QUERY_BUILDER_SIGNAL_SOURCES),
		metricName: Schema.String,
		metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
		isMonotonic: Schema.Boolean,
	}),
	Schema.Struct({ ...draftFields, dataSource: Schema.Literal("product_events") }),
])
export type QueryDraft = typeof QueryDraft.Type

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
	/** A note's body; static, it never reaches the warehouse. */
	markdownContent: Schema.String,
})
export type EditorState = typeof EditorState.Type

/** `chartPresentation.showPoints` and `PointsMode`: absent is Auto. */
export const pointsModeFromShowPoints = (showPoints: boolean | undefined): PointsMode =>
	showPoints === undefined ? "auto" : showPoints ? "always" : "never"
export const showPointsFromPointsMode = (mode: PointsMode): boolean | undefined =>
	mode === "auto" ? undefined : mode === "always"

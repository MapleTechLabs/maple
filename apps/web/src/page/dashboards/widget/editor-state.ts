import {
	HEATMAP_COLOR_SCALES,
	HEATMAP_SCALE_TYPES,
	STAT_AGGREGATES,
	TimeRangeSchema,
	WIDGET_VISUALIZATIONS,
} from "@maple/domain/http"
import {
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelPageStep,
	FunnelSessionStep,
	FunnelVariant,
	PathsDirection,
	PathsInclude,
	QUERY_COMPARISON_MODES,
} from "@maple/query-model"
import { Schema } from "effect"
import { QueryDraft } from "../../kit/query-builder/draft"

// The widget editor's state (`QueryBuilderWidgetState`).

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

/** `ListColumnDraft` (list-widget-config.ts). */
export const ListColumn = Schema.Struct({
	field: Schema.String,
	header: Schema.String,
	unit: Schema.optionalKey(Schema.String),
	align: Schema.optionalKey(Schema.Literals(["left", "center", "right"])),
})
export type ListColumn = typeof ListColumn.Type

export const ListDataSource = Schema.Literals(["traces", "logs", "product_events"])
export type ListDataSource = typeof ListDataSource.Type

/** `FunnelStepDraft` (funnel-filters.ts): the wire step plus an event step's filter as typed. */
export const StepDraft = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("event"),
		eventName: Schema.String,
		attributeEquals: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
		filterClause: Schema.optionalKey(Schema.String),
	}),
	FunnelPageStep,
	FunnelSessionStep,
])
export type StepDraft = typeof StepDraft.Type

export const FunnelAddOns = Schema.Struct({
	keyBy: Schema.Boolean,
	window: Schema.Boolean,
	breakdown: Schema.Boolean,
})

/** `FunnelWidgetDraft`. */
export const FunnelDraft = Schema.Struct({
	source: Schema.Literals(["product_events", "query_set"]),
	steps: Schema.Array(StepDraft),
	keyBy: FunnelKeyBy,
	windowSeconds: Schema.Number,
	breakdownBy: Schema.optionalKey(FunnelBreakdownBy),
	filterClause: Schema.String,
	/** `null`: Auto. */
	showStepPercent: Schema.NullOr(Schema.Boolean),
	variant: FunnelVariant,
	addOns: FunnelAddOns,
})
export type FunnelDraft = typeof FunnelDraft.Type

export const PathsAddOns = Schema.Struct({
	keyBy: Schema.Boolean,
	window: Schema.Boolean,
	include: Schema.Boolean,
	exclude: Schema.Boolean,
})

/** `PathsWidgetDraft`. */
export const PathsDraft = Schema.Struct({
	anchor: StepDraft,
	direction: PathsDirection,
	depth: Schema.Number,
	branches: Schema.Number,
	keyBy: FunnelKeyBy,
	windowSeconds: Schema.Number,
	include: PathsInclude,
	excludeText: Schema.String,
	filterClause: Schema.String,
	addOns: PathsAddOns,
})
export type PathsDraft = typeof PathsDraft.Type

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
	/** `null`: never chosen, so Apply leaves `display.heatmap.colorScale` absent. */
	heatmapColorScale: Schema.NullOr(Schema.Literals(HEATMAP_COLOR_SCALES)),
	heatmapScaleType: Schema.Literals(HEATMAP_SCALE_TYPES),
	/** A note's body; static, it never reaches the warehouse. */
	markdownContent: Schema.String,
	listDataSource: ListDataSource,
	listWhereClause: Schema.String,
	listLimit: Schema.String,
	listColumns: Schema.Array(ListColumn),
	listRootOnly: Schema.Boolean,
	funnel: FunnelDraft,
	paths: PathsDraft,
})
export type EditorState = typeof EditorState.Type

/** `chartPresentation.showPoints` and `PointsMode`: absent is Auto. */
export const pointsModeFromShowPoints = (showPoints: boolean | undefined): PointsMode =>
	showPoints === undefined ? "auto" : showPoints ? "always" : "never"
export const showPointsFromPointsMode = (mode: PointsMode): boolean | undefined =>
	mode === "auto" ? undefined : mode === "always"

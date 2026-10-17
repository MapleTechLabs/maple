import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"

/**
 * Everything a chart definition is built from, as data. The view renders it into the chart host's
 * `data-chart-spec` attribute and the chart Mount rebuilds the `@tanstack/charts` definition from it,
 * so the definition follows the Model the way a React `useMemo` follows its props.
 *
 * Optional values are `NullOr`, not `Option`: this is a JSON wire format, not Model state.
 */

const Nullable = <S extends Schema.Top>(schema: S) => Schema.NullOr(schema)

export const PieSliceRow = Schema.Struct({
	name: Schema.String,
	value: Schema.Number,
	color: Schema.String,
	collapsedCount: Schema.optionalKey(Schema.Number),
})
export type PieSliceRow = typeof PieSliceRow.Type

export const NumericBin = Schema.Struct({ x1: Schema.Number, x2: Schema.Number, value: Schema.Number })
export type NumericBin = typeof NumericBin.Type

export const CategoricalBin = Schema.Struct({ name: Schema.String, value: Schema.Number })
export type CategoricalBin = typeof CategoricalBin.Type

export const ChartSpec = defineTaggedUnion({
	/** `QueryBuilderPieChart`. */
	Pie: {
		rows: Schema.Array(PieSliceRow),
		activeName: Nullable(Schema.String),
		highlighted: Nullable(Schema.String),
		background: Schema.String,
		donut: Schema.Boolean,
		innerRadius: Nullable(Schema.Number),
		showLabels: Schema.Boolean,
		showPercent: Schema.Boolean,
		unit: Nullable(Schema.String),
		showTooltip: Schema.Boolean,
	},
	/** `PieFigure` in apps/web/src/lab/charts/pie-spike.tsx. `activeName` absent = not wired. */
	PieSpike: {
		rows: Schema.Array(PieSliceRow),
		donut: Schema.Boolean,
		activeName: Schema.optionalKey(Nullable(Schema.String)),
	},
	/** `NumericHistogram` in `QueryBuilderHistogramChart`. */
	NumericHistogram: {
		bins: Schema.Array(NumericBin),
		color: Schema.String,
		unit: Nullable(Schema.String),
		useLogY: Schema.Boolean,
		showTooltip: Schema.Boolean,
	},
	/** `CategoricalHistogram` in `QueryBuilderHistogramChart`. */
	CategoricalHistogram: {
		bins: Schema.Array(CategoricalBin),
		color: Schema.String,
		useLogY: Schema.Boolean,
		showTooltip: Schema.Boolean,
	},
	/** `PlotSparkline`: the services table's trend line. */
	Sparkline: {
		values: Schema.Array(Schema.Number),
		color: Schema.String,
		gradientId: Schema.String,
		fillStart: Schema.Number,
		fillEnd: Schema.Number,
		/** Bumped when the data arrives again: React rebuilds the definition on every new result. */
		revision: Schema.Number,
	},
	/** `HistogramSpike` (binX over raw observations) in apps/web/src/lab/charts/histogram-spike.tsx. */
	BinnedHistogram: {
		values: Schema.Array(Schema.Number),
		color: Schema.String,
		logScaleY: Schema.Boolean,
	},
})
export type ChartSpec = typeof ChartSpec.Type

const ChartSpecJson = Schema.fromJsonString(ChartSpec)

export const encodeChartSpec = Schema.encodeSync(ChartSpecJson)
export const decodeChartSpec = Schema.decodeUnknownOption(ChartSpecJson)

/** What a tooltip body renders: the focused datum, reduced to data. */
export const ChartTooltip = defineTaggedUnion({
	PieSlice: {
		name: Schema.String,
		value: Schema.Number,
		fraction: Schema.Number,
		color: Schema.String,
		collapsedCount: Schema.optionalKey(Schema.Number),
	},
	NumericBin: { x1: Schema.Number, x2: Schema.Number, value: Schema.Number },
	CategoricalBin: { name: Schema.String, value: Schema.Number },
})
export type ChartTooltip = typeof ChartTooltip.Type

/** The attribute the chart Mount watches. */
export const CHART_SPEC_ATTRIBUTE = "data-chart-spec"

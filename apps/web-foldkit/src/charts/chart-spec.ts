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

/** One bucket of a fixed-metric chart: the bucket plus its primitive columns. */
export const FixedMetricRow = Schema.Record(
	Schema.String,
	Schema.Union([Schema.Number, Schema.String, Schema.Boolean, Schema.Null]),
)
export type FixedMetricRow = typeof FixedMetricRow.Type

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
		/** `PlotSparkline`'s `curve`; absent is linear. */
		curve: Schema.optionalKey(Schema.Literals(["linear", "monotone"])),
	},
	/**
	 * `QueryBuilderAreaChart` (unstacked, linear): the query's rows as returned, the resolved colour
	 * per series key (`s1..sN`), and the clock that decides the in-flight tail.
	 */
	QueryBuilderArea: {
		data: Schema.Array(
			Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
		),
		colors: Schema.Record(Schema.String, Schema.String),
		/** Series keys the legend hid: not painted, and not on the y axis. */
		hidden: Schema.Array(Schema.String),
		fallbackColor: Schema.String,
		chrome: Schema.Struct({ border: Schema.String, background: Schema.String }),
		unit: Nullable(Schema.String),
		timeZone: Nullable(Schema.String),
		nowMs: Schema.Number,
		containerWidth: Schema.Number,
		gradientPrefix: Schema.String,
		showTooltip: Schema.Boolean,
	},
	/**
	 * `QueryBuilderBarChart` (threshold-free, linear): the rows as returned, the resolved colour per
	 * series key (`s1..sN`), stacked or grouped, and the clock that decides the in-flight tail.
	 */
	QueryBuilderBar: {
		data: Schema.Array(
			Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
		),
		colors: Schema.Record(Schema.String, Schema.String),
		fallbackColor: Schema.String,
		unit: Nullable(Schema.String),
		timeZone: Nullable(Schema.String),
		nowMs: Schema.Number,
		stacked: Schema.Boolean,
		showTooltip: Schema.Boolean,
	},
	/** `IssueOccurrenceChart` (apps/web/src/components/errors): bucketed counts as bars. */
	Occurrences: {
		points: Schema.Array(Schema.Struct({ bucket: Schema.String, count: Schema.Number })),
		color: Schema.String,
		timeZone: Schema.String,
	},
	/** `LogsVolumePlot`: the /logs severity histogram, stacked per bucket, with its drag selection. */
	LogsVolume: {
		buckets: Schema.Array(
			Schema.Struct({ bucket: Schema.String, counts: Schema.Record(Schema.String, Schema.Number) }),
		),
		seriesKeys: Schema.Array(Schema.String),
		/** Each series' resolved colour, by key. */
		colors: Schema.Record(Schema.String, Schema.String),
		border: Schema.String,
		selection: Nullable(Schema.Struct({ left: Schema.String, right: Schema.String })),
		isSelecting: Schema.Boolean,
		timeZone: Schema.String,
	},
	/** `HistogramSpike` (binX over raw observations) in apps/web/src/lab/charts/histogram-spike.tsx. */
	BinnedHistogram: {
		values: Schema.Array(Schema.Number),
		color: Schema.String,
		logScaleY: Schema.Boolean,
	},
	/** `InfraMetricChart` (apps/web/src/components/infra/primitives): the host and Kubernetes detail charts. */
	InfraMetric: {
		rows: Schema.Array(
			Schema.Struct({ bucket: Schema.String, attributeValue: Schema.String, value: Schema.Number }),
		),
		unit: Schema.String,
		seriesLabel: Nullable(Schema.String),
		stacked: Schema.Boolean,
		showThreshold: Schema.Boolean,
		/** Bucket ISO strings the x axis spans (siblings sharing one axis); `null` domains over the rows. */
		xDomain: Nullable(Schema.Array(Schema.String)),
		gaps: Schema.Boolean,
		/** Resolved colour per series name (`resolveSeriesColors`, then the call site's overrides). */
		colors: Schema.Record(Schema.String, Schema.String),
		chrome: Schema.Struct({ border: Schema.String, background: Schema.String }),
		/** The 80% rule's colour, `--severity-warn` resolved. */
		thresholdColor: Schema.String,
		gradientPrefix: Schema.String,
		timeZone: Schema.String,
	},
	/** `ThroughputAreaChart`, `ErrorRateAreaChart`, `ApdexAreaChart`, `LatencyLineChart` (charts/area, charts/line). */
	FixedMetric: {
		chart: Schema.Literals(["Throughput", "ErrorRate", "Latency", "Apdex"]),
		/** `yAxisWidth`: a left-margin lock that aligns plot rects across a grid. */
		marginLeft: Schema.optionalKey(Schema.Number),
		rows: Schema.Array(FixedMetricRow),
		/** Resolved series colours by series key; `border`/`background` are the chrome. */
		colors: Schema.Record(Schema.String, Schema.String),
		perSecond: Schema.Boolean,
		timeZone: Nullable(Schema.String),
		/** The render-time clock the in-flight split reads (`Date.now()` in legacy). */
		nowMs: Schema.Number,
		gradientPrefix: Schema.String,
		showTooltip: Schema.Boolean,
	},
	/**
	 * `AlertRuleChart` (apps/web/src/components/alerts/alert-rule-chart.tsx): the rule's signal, the
	 * threshold rules and the shaded bands, already decided by `@maple/web-data/alerts/chart-series`.
	 */
	AlertRule: {
		rows: Schema.Array(Schema.Record(Schema.String, Schema.NullOr(Schema.Number))),
		seriesKeys: Schema.Array(Schema.String),
		/** Tooltip labels by series key (`Query`, `Evaluated`, or the group). */
		labels: Schema.Record(Schema.String, Schema.String),
		isMultiSeries: Schema.Boolean,
		hasGhost: Schema.Boolean,
		/** Resolved colours: `signal`, `destructive`, `warn`, `muted`, `border`, `background`, series keys. */
		colors: Schema.Record(Schema.String, Schema.String),
		domainMin: Schema.Number,
		domainMax: Schema.Number,
		yMax: Schema.Number,
		threshold: Schema.Number,
		thresholdUpper: Nullable(Schema.Number),
		criticalThreshold: Nullable(Schema.Number),
		comparator: Schema.String,
		signalType: Schema.String,
		bands: Schema.Struct({
			noData: Schema.Array(Schema.Struct({ x1: Schema.Number, x2: Schema.Number })),
			incidentOpen: Schema.Array(Schema.Struct({ x1: Schema.Number, x2: Schema.Number })),
			incidentClosed: Schema.Array(Schema.Struct({ x1: Schema.Number, x2: Schema.Number })),
			held: Schema.Array(Schema.Struct({ x1: Schema.Number, x2: Schema.Number })),
			wouldFire: Schema.Array(Schema.Struct({ x1: Schema.Number, x2: Schema.Number })),
		}),
		/** The tooltip heading's per-bucket facts (`bucketMeta`). */
		meta: Schema.Array(
			Schema.Struct({
				t: Schema.Number,
				sampleCount: Schema.Number,
				status: Schema.String,
				provisional: Schema.Boolean,
			}),
		),
		timeZone: Schema.String,
		bucketSeconds: Nullable(Schema.Number),
		gradientId: Schema.String,
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
	/** `PlotTooltipBody` for a fixed-metric chart: the bucket heading and one formatted row per series. */
	Bucket: {
		heading: Schema.String,
		rows: Schema.Array(
			Schema.Struct({
				label: Schema.String,
				color: Schema.String,
				dashed: Schema.Boolean,
				value: Schema.String,
			}),
		),
	},
})
export type ChartTooltip = typeof ChartTooltip.Type

/** The attribute the chart Mount watches. */
export const CHART_SPEC_ATTRIBUTE = "data-chart-spec"

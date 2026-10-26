import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { ChartEventMarker, MarkerColors } from "./event-marker-spec"

/**
 * Everything a chart definition is built from, as data. The view renders it into the chart host's
 * `data-chart-spec` attribute and the chart Mount rebuilds the `@tanstack/charts` definition from it,
 * so the definition follows the Model.
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

/**
 * The y-axis settings a widget's line, area or bar chart honours: threshold rules (colours already
 * canvas-safe literals), log scale and the soft bounds.
 */
export const TimeseriesAxisSpec = Schema.Struct({
	thresholds: Schema.Array(
		Schema.Struct({ value: Schema.Number, color: Schema.String, label: Schema.NullOr(Schema.String) }),
	),
	logScale: Schema.Boolean,
	softMin: Schema.NullOr(Schema.Number),
	softMax: Schema.NullOr(Schema.Number),
	fitYAxisToData: Schema.Boolean,
})
export type TimeseriesAxisSpec = typeof TimeseriesAxisSpec.Type

/** One heatmap slot: a cell, or a hole when `value` is null. */
export const HeatmapSlotSchema = Schema.Struct({
	x: Schema.String,
	y: Schema.String,
	value: Schema.NullOr(Schema.Number),
})

/** One bucket of a fixed-metric chart: the bucket plus its primitive columns. */
export const FixedMetricRow = Schema.Record(
	Schema.String,
	Schema.Union([Schema.Number, Schema.String, Schema.Boolean, Schema.Null]),
)
export type FixedMetricRow = typeof FixedMetricRow.Type

export const ChartSpec = defineTaggedUnion({
	/**
	 * The agent tool series chart and the tool detail grid: one
	 * monotone line per series over zero-filled buckets, colours resolved, ticks in the metric's unit.
	 */
	ToolSeries: {
		rows: Schema.Array(FixedMetricRow),
		series: Schema.Array(
			Schema.Struct({ key: Schema.String, label: Schema.String, color: Schema.String }),
		),
		chrome: Schema.Struct({ border: Schema.String, background: Schema.String }),
		/** The tick and tooltip format: a tool metric (overview), or one of the detail grid's formatters. */
		format: Schema.Literals([
			"calls",
			"sessions",
			"error_rate",
			"duration",
			"number",
			"errorRate",
			"durationNs",
			"oneDecimal",
		]),
		tickCount: Schema.NullOr(Schema.Number),
		marginTop: Schema.Number,
		timeZone: Schema.String,
	},
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
	/** The lab pie figure. `activeName` absent = not wired. */
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
		/** Bumped when the data arrives again: every new result rebuilds the definition. */
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
		/** `QueryBuilderLineChart` draws lines over the same rows; absent is the area chart. */
		mark: Schema.optionalKey(Schema.Literals(["area", "line"])),
		/** `stacked`: bands on top of each other, flat fills, no closed-run edges. */
		stacked: Schema.optionalKey(Schema.Boolean),
		/** `curveType`; absent is linear. */
		curve: Schema.optionalKey(Schema.Literals(["linear", "monotone"])),
		/** `showPoints`: every point, none, or (absent) only isolated ones unless they fit. */
		showPoints: Schema.optionalKey(Schema.Boolean),
		axis: Schema.optionalKey(TimeseriesAxisSpec),
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
		axis: Schema.optionalKey(TimeseriesAxisSpec),
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
	/** The lab histogram (binX over raw observations). */
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
		unit: Schema.Literals([
			"percent",
			"cores",
			"seconds",
			"load",
			"bytes_per_second",
			"bytes",
			"milliseconds",
			"rate",
			"count",
		]),
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
		/** Deploy markers drawn at the same instant on every strip. */
		markers: Schema.Array(ChartEventMarker),
		markerColors: MarkerColors,
	},
	/**
	 * The `/lab/bench/tanstack` overview charts: point-scaled
	 * buckets, y pinned at 0, no legend. Rows are `overviewBenchRows`.
	 */
	BenchOverview: {
		chart: Schema.Literals(["Throughput", "ErrorRate", "Latency"]),
		rows: Schema.Array(FixedMetricRow),
		/** Resolved series colours by series key; `border`/`background` are the chrome. */
		colors: Schema.Record(Schema.String, Schema.String),
		gradientId: Schema.String,
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
		/** The render-time clock the in-flight split reads. */
		nowMs: Schema.Number,
		gradientPrefix: Schema.String,
		showTooltip: Schema.Boolean,
	},
	/**
	 * The alert rule chart: the rule's signal, the
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
	/** The Cloudflare zone detail's stacked breakdown chart. */
	StackedBreakdown: {
		rows: Schema.Array(
			Schema.Struct({ bucket: Schema.String, attributeValue: Schema.String, value: Schema.Number }),
		),
		/** Stack and legend order, already folded and ranked. */
		series: Schema.Array(Schema.String),
		/** Display label per series (the pooled tail reads "Other"). */
		labels: Schema.Record(Schema.String, Schema.String),
		/** Resolved colour per series, plus `border` / `background` chrome. */
		colors: Schema.Record(Schema.String, Schema.String),
		timeZone: Schema.String,
		gradientPrefix: Schema.String,
		/** Ticks and tooltip values in this unit (`formatValueByUnit`); plain numbers without it. */
		unit: Schema.optionalKey(Schema.Literal("duration_ms")),
		/** The tooltip closes with the bucket's sum across the series. */
		showTotal: Schema.optionalKey(Schema.Boolean),
	},
	/**
	 * The analytics traffic chart: the selected metric
	 * and its companion per bucket, painted largest total first, ticks in the metric's format.
	 */
	AnalyticsTraffic: {
		points: Schema.Array(
			Schema.Struct({
				bucket: Schema.String,
				primary: Schema.optionalKey(Nullable(Schema.Number)),
				companion: Schema.optionalKey(Nullable(Schema.Number)),
			}),
		),
		/** The metric keys behind `primary` and (when paired) `companion`, in paint order. */
		series: Schema.Array(
			Schema.Struct({ key: Schema.Literals(["primary", "companion"]), metric: Schema.String }),
		),
		/** The metric whose format the y ticks use. */
		tickMetric: Schema.String,
		/** Resolved `primary` / `companion` colours plus `border` / `background` chrome. */
		colors: Schema.Record(Schema.String, Schema.String),
		timeZone: Schema.String,
		gradientPrefix: Schema.String,
		isNarrow: Schema.Boolean,
	},
	/** The PlanetScale chart: one gauge, gaps kept. */
	PlanetScaleMetric: {
		metric: Schema.Literals([
			"connectionsAvg",
			"cpuMaxPercent",
			"memMaxPercent",
			"storageUsedPercent",
			"replicaLagMaxSeconds",
		]),
		points: Schema.Array(Schema.Struct({ bucket: Schema.String, value: Nullable(Schema.Number) })),
		/** The series colour plus `border` / `background` chrome. */
		colors: Schema.Record(Schema.String, Schema.String),
		markers: Schema.Array(ChartEventMarker),
		markerColors: MarkerColors,
		timeZone: Schema.String,
	},
	/** `AnomalyTimeseriesChart` (components/anomalies/): observed signal, baseline and threshold rules. */
	AnomalySignal: {
		points: Schema.Array(Schema.Struct({ bucket: Schema.String, value: Schema.Number })),
		signalType: Schema.Literals(["error_rate", "latency_p95", "throughput", "error_spike", "log_volume"]),
		baselineMedian: Schema.Number,
		thresholdValue: Schema.Number,
		firstTriggeredAt: Schema.String,
		resolvedAt: Nullable(Schema.String),
		/** `stroke`, `muted`, `threshold`, plus `border` / `background` chrome, resolved. */
		colors: Schema.Record(Schema.String, Schema.String),
		gradientId: Schema.String,
		timeZone: Schema.String,
	},
	/**
	 * The spend chart: cumulative spend by band, day
	 * by day (`buildCumulativeSeries`), and the dashed projection to the end of the cycle.
	 */
	SpendCumulative: {
		points: Schema.Array(
			Schema.Struct({
				date: Schema.String,
				dayMs: Schema.Number,
				/** Cumulative dollars per band (`base`, then each feature); `null` on days to come. */
				bands: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
				projected: Nullable(Schema.Number),
				future: Schema.Boolean,
			}),
		),
		bands: Schema.Array(
			Schema.Struct({ key: Schema.String, label: Schema.String, color: Schema.String }),
		),
		primary: Schema.String,
		chrome: Schema.Struct({ border: Schema.String, background: Schema.String }),
		projected: Schema.Number,
		yMax: Schema.Number,
		currency: Schema.String,
	},
	/** `QueryBuilderHeatmapChart`: band cells and focusable holes over a sequential ramp. */
	Heatmap: {
		cells: Schema.Array(HeatmapSlotSchema),
		holes: Schema.Array(HeatmapSlotSchema),
		xDomain: Schema.Array(Schema.String),
		yDomain: Schema.Array(Schema.String),
		/** The y tick text per category, already shortened and truncated into the gutter. */
		yLabels: Schema.Record(Schema.String, Schema.String),
		margin: Nullable(
			Schema.Struct({
				top: Schema.Number,
				right: Schema.Number,
				bottom: Schema.Number,
				left: Schema.Number,
			}),
		),
		paddingInnerX: Schema.Number,
		paddingInnerY: Schema.Number,
		radius: Schema.Number,
		stops: Schema.Array(Schema.String),
		domain: Schema.Tuple([Schema.Number, Schema.Number]),
		scaleType: Schema.Literals(["linear", "log"]),
		grout: Schema.String,
		foreground: Schema.String,
		showTooltip: Schema.Boolean,
	},
	/**
	 * A `/lab/charts` prototype, drawn by the lab's own host (`lab/charts/spike-host.ts`): the arm
	 * names its fixture and definition; the legend's emphasis and the resolved tokens ride along.
	 */
	LabSpike: {
		arm: Schema.String,
		colors: Schema.Record(Schema.String, Schema.String),
		highlighted: Nullable(Schema.String),
		active: Nullable(Schema.String),
		hidden: Schema.Array(Schema.String),
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
	HeatmapSlot: { x: Schema.String, y: Schema.String, value: Schema.NullOr(Schema.Number) },
	/** `PlotTooltipBody` for a fixed-metric chart: the bucket heading and one formatted row per series. */
	Bucket: {
		heading: Schema.String,
		/** The row `PlotTooltipBody` emphasises: the series nearest the cursor. */
		highlighted: Schema.optionalKey(Schema.String),
		rows: Schema.Array(
			Schema.Struct({
				label: Schema.String,
				color: Schema.String,
				dashed: Schema.Boolean,
				value: Schema.String,
			}),
		),
		/** A closing total row under the series (the lab's stacked bar). */
		total: Schema.optionalKey(Schema.String),
	},
})
export type ChartTooltip = typeof ChartTooltip.Type

/** The attribute the chart Mount watches. */
export const CHART_SPEC_ATTRIBUTE = "data-chart-spec"

/** The chart's accessible name, watched with the spec so a relabelled chart is relabelled in place. */
export const CHART_LABEL_ATTRIBUTE = "data-chart-label"

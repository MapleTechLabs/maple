import { ChartSpec } from "./chart-spec"
import { Option } from "effect"
import { type ChartHost, type ChartHostOptions, type CreateChartHost, hostFor, variant } from "./chart-host-base"
import { buildAlertRule } from "./definitions/alert-rule"
import { buildAnalyticsTraffic } from "./definitions/analytics-traffic"
import { buildQueryBuilderArea } from "./definitions/area"
import { buildQueryBuilderBar } from "./definitions/bar"
import {
	buildBinnedHistogram,
	buildCategoricalHistogram,
	buildNumericHistogram,
} from "./definitions/histogram"
import { buildBenchOverview } from "./definitions/bench-overview"
import { buildFixedMetric } from "./definitions/fixed-metric"
import { buildInfraMetric } from "./definitions/infra-metric"
import { buildPlanetScaleMetric } from "./definitions/planetscale-metric"
import { buildLogsVolume } from "./definitions/logs-volume"
import { buildPie, buildPieSpike } from "./definitions/pie"
import { buildOccurrences } from "./definitions/occurrences"
import { buildAnomalySignal } from "./definitions/anomaly-signal"
import { buildSparkline } from "./definitions/sparkline"
import { buildStackedBreakdown } from "./definitions/stacked-breakdown"
import { buildToolSeries } from "./definitions/tool-series"
import { buildSpendCumulative } from "./definitions/spend"
import { buildHeatmap } from "./definitions/heatmap"

const definedHost = (
	container: HTMLElement,
	spec: ChartSpec,
	height: number,
	options: ChartHostOptions,
): ChartHost | undefined =>
	ChartSpec.match<ChartHost | undefined>(spec, {
		Pie: (pie) => hostFor(container, pie, height, variant("Pie"), buildPie, options),
		PieSpike: (pie) => hostFor(container, pie, height, variant("PieSpike"), buildPieSpike, options),
		NumericHistogram: (histogram) =>
			hostFor(
				container,
				histogram,
				height,
				variant("NumericHistogram"),
				buildNumericHistogram,
				options,
			),
		CategoricalHistogram: (histogram) =>
			hostFor(
				container,
				histogram,
				height,
				variant("CategoricalHistogram"),
				buildCategoricalHistogram,
				options,
			),
		Sparkline: (sparkline) =>
			hostFor(container, sparkline, height, variant("Sparkline"), buildSparkline, options),
		QueryBuilderArea: (area) =>
			hostFor(container, area, height, variant("QueryBuilderArea"), buildQueryBuilderArea, options),
		QueryBuilderBar: (bar) =>
			hostFor(container, bar, height, variant("QueryBuilderBar"), buildQueryBuilderBar, options),
		Occurrences: (occurrences) =>
			hostFor(container, occurrences, height, variant("Occurrences"), buildOccurrences, options),
		LogsVolume: (volume) =>
			hostFor(container, volume, height, variant("LogsVolume"), buildLogsVolume, options),
		BinnedHistogram: (histogram) =>
			hostFor(container, histogram, height, variant("BinnedHistogram"), buildBinnedHistogram, options),
		BenchOverview: (bench) =>
			hostFor(container, bench, height, variant("BenchOverview"), buildBenchOverview, options),
		FixedMetric: (metric) =>
			hostFor(container, metric, height, variant("FixedMetric"), buildFixedMetric, options),
		AlertRule: (rule) => hostFor(container, rule, height, variant("AlertRule"), buildAlertRule, options),
		AnomalySignal: (signal) =>
			hostFor(container, signal, height, variant("AnomalySignal"), buildAnomalySignal, options),
		SpendCumulative: (spend) =>
			hostFor(container, spend, height, variant("SpendCumulative"), buildSpendCumulative, options),
		InfraMetric: (metric) =>
			hostFor(container, metric, height, variant("InfraMetric"), buildInfraMetric, options),
		AnalyticsTraffic: (traffic) =>
			hostFor(container, traffic, height, variant("AnalyticsTraffic"), buildAnalyticsTraffic, options),
		PlanetScaleMetric: (metric) =>
			hostFor(container, metric, height, variant("PlanetScaleMetric"), buildPlanetScaleMetric, options),
		StackedBreakdown: (breakdown) =>
			hostFor(
				container,
				breakdown,
				height,
				variant("StackedBreakdown"),
				buildStackedBreakdown,
				options,
			),
		ToolSeries: (series) =>
			hostFor(container, series, height, variant("ToolSeries"), buildToolSeries, options),
		Heatmap: (heatmap) => hostFor(container, heatmap, height, variant("Heatmap"), buildHeatmap, options),
		// Drawn by the lab's host (`MountChart host: "lab"`); this host has no definition for it.
		LabSpike: () => undefined,
	})

/** Mounts the chart a spec describes into `container` (the `.ts-chart-surface` element). */
export const createChartHost: CreateChartHost = (container, spec, height, options) =>
	Option.fromNullishOr(definedHost(container, spec, height, options))

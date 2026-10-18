import type { ChartBounds, ChartValue, ResolvedScale } from "@tanstack/charts"
import { createChartRendererAdapter } from "@tanstack/charts/adapter/renderer"
import { canvasChartRenderer } from "@tanstack/charts/canvas"
import { renderChartSvg } from "@tanstack/charts/svg"
import { createSvgChartRenderer } from "@tanstack/charts/svg/renderer"
import { Option } from "effect"
import { ChartSpec, type ChartTooltip } from "./chart-spec"
import { buildQueryBuilderArea } from "./definitions/area"
import type { BuiltChart } from "./definitions/built-chart"
import {
	buildBinnedHistogram,
	buildCategoricalHistogram,
	buildNumericHistogram,
} from "./definitions/histogram"
import { buildFixedMetric } from "./definitions/fixed-metric"
import { buildInfraMetric } from "./definitions/infra-metric"
import { buildPlanetScaleMetric } from "./definitions/planetscale-metric"
import { buildLogsVolume } from "./definitions/logs-volume"
import { buildPie, buildPieSpike } from "./definitions/pie"
import { buildOccurrences } from "./definitions/occurrences"
import { buildSparkline } from "./definitions/sparkline"
import { buildStackedBreakdown } from "./definitions/stacked-breakdown"

/**
 * What `RendererChartImplementation` (`@tanstack/charts/react`) does with a `CanvasChart` or SVG
 * `Chart`, without React: one adapter per container, `update` on every new definition or height.
 * Imported lazily by the chart Mount, so `@tanstack/charts` never reaches the startup bundle.
 */

export type ChartRendererKind = "canvas" | "svg"

/** A time x scale reduced to its affine map: the domain ends in epoch ms and their pixels. */
export interface TimeAxis {
	readonly domainStartMs: number
	readonly domainEndMs: number
	readonly rangeStart: number
	readonly rangeEnd: number
}

const timeAxisOf = (scale: ResolvedScale | undefined): Option.Option<TimeAxis> => {
	const start = scale?.domain[0]
	const end = scale?.domain[scale.domain.length - 1]
	return scale !== undefined && start instanceof Date && end instanceof Date
		? Option.some({
				domainStartMs: start.getTime(),
				domainEndMs: end.getTime(),
				rangeStart: scale.map(start),
				rangeEnd: scale.map(end),
			})
		: Option.none()
}

export interface ChartHostCallbacks {
	readonly onFocusChange: (maybeKey: Option.Option<string>) => void
	readonly onTooltipChange: (maybeTooltip: Option.Option<ChartTooltip>) => void
	readonly onRender: (bounds: ChartBounds, timeAxis: Option.Option<TimeAxis>) => void
}

export interface ChartHostOptions {
	readonly ariaLabel: string
	readonly idPrefix: string
	readonly renderer: ChartRendererKind
	readonly callbacks: ChartHostCallbacks
}

export interface ChartHost {
	/** False when the spec's kind changed; the caller destroys this host and creates a new one. */
	readonly update: (spec: ChartSpec, height: number) => boolean
	readonly destroy: () => void
}

const hostFor = <S extends ChartSpec, TDatum, X extends ChartValue, Y extends ChartValue>(
	container: HTMLElement,
	initialSpec: S,
	initialHeight: number,
	narrow: (spec: ChartSpec) => Option.Option<S>,
	build: (spec: S) => BuiltChart<TDatum, X, Y>,
	{ ariaLabel, idPrefix, renderer, callbacks }: ChartHostOptions,
): ChartHost => {
	// One renderer per host, as the React components memoise it: a new one would remount the surface.
	const chartRenderer = renderer === "canvas" ? canvasChartRenderer : createSvgChartRenderer(renderChartSvg)
	// NOTE: the callbacks must keep their identity across updates, like React's `useCallback`s: the
	// tooltip replaces its body element whenever `onTooltipBodyChange` changes, detaching the portaled body.
	const current = { built: build(initialSpec) }
	const onFocusChange = (point: Parameters<BuiltChart<TDatum, X, Y>["focusKeyOf"]>[0] | null) =>
		callbacks.onFocusChange(Option.map(Option.fromNullishOr(point), current.built.focusKeyOf))
	const onTooltipBodyChange = (
		target: { readonly points: Parameters<BuiltChart<TDatum, X, Y>["tooltipOf"]>[0] } | null,
	) => callbacks.onTooltipChange(target === null ? Option.none() : current.built.tooltipOf(target.points))
	const onRender = (context: {
		readonly scene: {
			readonly chart: ChartBounds
			readonly scales: Readonly<Record<string, ResolvedScale>>
		}
	}) => callbacks.onRender(context.scene.chart, timeAxisOf(context.scene.scales.x))
	const optionsFor = (height: number) => ({
		renderer: chartRenderer,
		definition: current.built.definition,
		ariaLabel,
		idPrefix,
		height,
		initialWidth: 640,
		onFocusChange,
		onTooltipBodyChange,
		onRender,
	})

	const adapter = createChartRendererAdapter(optionsFor(initialHeight))
	adapter.mount(container)

	return {
		update: (spec, height) =>
			Option.match(narrow(spec), {
				onNone: () => false,
				onSome: (next) => {
					current.built = build(next)
					adapter.update(optionsFor(height))
					return true
				},
			}),
		destroy: () => adapter.destroy(),
	}
}

const variant =
	<Tag extends ChartSpec["_tag"]>(tag: Tag) =>
	(spec: ChartSpec): Option.Option<Extract<ChartSpec, { readonly _tag: Tag }>> =>
		Option.liftPredicate(
			spec,
			(candidate): candidate is Extract<ChartSpec, { readonly _tag: Tag }> => candidate._tag === tag,
		)

/** Mounts the chart a spec describes into `container` (the `.ts-chart-surface` element). */
export const createChartHost = (
	container: HTMLElement,
	spec: ChartSpec,
	height: number,
	options: ChartHostOptions,
): ChartHost =>
	ChartSpec.match(spec, {
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
		Occurrences: (occurrences) =>
			hostFor(container, occurrences, height, variant("Occurrences"), buildOccurrences, options),
		LogsVolume: (volume) =>
			hostFor(container, volume, height, variant("LogsVolume"), buildLogsVolume, options),
		BinnedHistogram: (histogram) =>
			hostFor(container, histogram, height, variant("BinnedHistogram"), buildBinnedHistogram, options),
		FixedMetric: (metric) =>
			hostFor(container, metric, height, variant("FixedMetric"), buildFixedMetric, options),
		InfraMetric: (metric) =>
			hostFor(container, metric, height, variant("InfraMetric"), buildInfraMetric, options),
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
	})

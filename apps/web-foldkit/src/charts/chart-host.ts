import type { ChartBounds, ChartValue } from "@tanstack/charts"
import { createChartRendererAdapter } from "@tanstack/charts/adapter/renderer"
import { canvasChartRenderer } from "@tanstack/charts/canvas"
import { renderChartSvg } from "@tanstack/charts/svg"
import { createSvgChartRenderer } from "@tanstack/charts/svg/renderer"
import { Option } from "effect"
import { ChartSpec, type ChartTooltip } from "./chart-spec"
import type { BuiltChart } from "./definitions/built-chart"
import {
	buildBinnedHistogram,
	buildCategoricalHistogram,
	buildNumericHistogram,
} from "./definitions/histogram"
import { buildPie, buildPieSpike } from "./definitions/pie"

/**
 * What `RendererChartImplementation` (`@tanstack/charts/react`) does with a `CanvasChart` or SVG
 * `Chart`, without React: one adapter per container, `update` on every new definition or height.
 * Imported lazily by the chart Mount, so `@tanstack/charts` never reaches the startup bundle.
 */

export type ChartRendererKind = "canvas" | "svg"

export interface ChartHostCallbacks {
	readonly onFocusChange: (maybeKey: Option.Option<string>) => void
	readonly onTooltipChange: (maybeTooltip: Option.Option<ChartTooltip>) => void
	readonly onRender: (bounds: ChartBounds) => void
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
	const onRender = (context: { readonly scene: { readonly chart: ChartBounds } }) =>
		callbacks.onRender(context.scene.chart)
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
		BinnedHistogram: (histogram) =>
			hostFor(container, histogram, height, variant("BinnedHistogram"), buildBinnedHistogram, options),
	})

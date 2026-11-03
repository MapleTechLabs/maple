import type { ChartBounds, ChartValue, ResolvedScale } from "@tanstack/charts"
import { createChartRendererAdapter } from "@tanstack/charts/adapter/renderer"
import { canvasChartRenderer } from "@tanstack/charts/canvas"
import { renderChartSvg } from "@tanstack/charts/svg"
import { createSvgChartRenderer } from "@tanstack/charts/svg/renderer"
import { Option } from "effect"
import type { ChartSpec, ChartTooltip } from "./chart-spec"
import type { BuiltChart } from "./definitions/built-chart"

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
	/** A library-drawn legend (`interactiveColorLegend`) toggled `key` of `keys`. */
	readonly onLegendToggle?: (key: string, keys: ReadonlyArray<string>) => void
}

export interface ChartHostOptions {
	/** Read at every draw: the frame relabels the chart without remounting it. */
	readonly ariaLabel: () => string
	readonly idPrefix: string
	readonly renderer: ChartRendererKind
	readonly callbacks: ChartHostCallbacks
}

export interface ChartHost {
	/** False when the spec's kind changed; the caller destroys this host and creates a new one. */
	readonly update: (spec: ChartSpec, height: number) => boolean
	readonly destroy: () => void
}

export const hostFor = <S extends ChartSpec, TDatum, X extends ChartValue, Y extends ChartValue>(
	container: HTMLElement,
	initialSpec: S,
	initialHeight: number,
	narrow: (spec: ChartSpec) => Option.Option<S>,
	build: (spec: S) => BuiltChart<TDatum, X, Y>,
	{ ariaLabel, idPrefix, renderer, callbacks }: ChartHostOptions,
): ChartHost => {
	// One renderer per host: a new one would remount the surface.
	const chartRenderer = renderer === "canvas" ? canvasChartRenderer : createSvgChartRenderer(renderChartSvg)
	// NOTE: the callbacks must keep their identity across updates: the
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
		ariaLabel: ariaLabel(),
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

export const variant =
	<Tag extends ChartSpec["_tag"]>(tag: Tag) =>
	(spec: ChartSpec): Option.Option<Extract<ChartSpec, { readonly _tag: Tag }>> =>
		Option.liftPredicate(
			spec,
			(candidate): candidate is Extract<ChartSpec, { readonly _tag: Tag }> => candidate._tag === tag,
		)

/**
 * What a chart host module exports: mounts the chart a spec describes into `container`, or `None`
 * when the host has no definition for it.
 */
export type CreateChartHost = (
	container: HTMLElement,
	spec: ChartSpec,
	height: number,
	options: ChartHostOptions,
) => Option.Option<ChartHost>

/**
 * A host that draws one chart kind, for a page that needs only that definition (the full host
 * imports every one).
 */
export const singleChartHost =
	<Tag extends ChartSpec["_tag"], TDatum, X extends ChartValue, Y extends ChartValue>(
		tag: Tag,
		build: (spec: Extract<ChartSpec, { readonly _tag: Tag }>) => BuiltChart<TDatum, X, Y>,
	): CreateChartHost =>
	(container, spec, height, options) =>
		Option.map(variant(tag)(spec), (narrowed) =>
			hostFor(container, narrowed, height, variant(tag), build, options),
		)

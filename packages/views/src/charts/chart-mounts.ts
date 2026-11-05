import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./chart"
import type { ChartBounds } from "@tanstack/charts"
import type { ChartHost, CreateChartHost, TimeAxis } from "./chart-host-base"
import { CHART_LABEL_ATTRIBUTE, CHART_SPEC_ATTRIBUTE, decodeChartSpec } from "./chart-spec"

/** `PlotFrame`'s `FALLBACK_HEIGHT`: drawn at until the plot box has been measured. */
const FALLBACK_HEIGHT = 320

export const PLOT_BOX_ATTRIBUTE = "data-chart-plot-box"

export const ChartRenderer = Schema.Literals(["canvas", "svg"])
export type ChartRenderer = typeof ChartRenderer.Type

const ChartMountMessage = Schema.Union([
	Message.CompletedMountChart,
	Message.FailedMountChart,
	Message.RenderedPlot,
	Message.ChangedChartFocus,
	Message.ChangedChartTooltip,
	Message.ToggledLegendSeries,
])
type ChartMountMessage = typeof ChartMountMessage.Type

export class ChartMountError extends Schema.TaggedError<ChartMountError>()("@maple/web/ChartMountError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

const failed = (reason: string) => Message.FailedMountChart({ reason })

interface ChartHostModule {
	readonly createChartHost: CreateChartHost
}

/** Hosts other than the full one (`./chart-host`, every definition), by name. */
export const ChartHostName = Schema.Literals(["lab", "logs-volume"])
export type ChartHostName = typeof ChartHostName.Type

/** The landing's host ships here; the `/lab/charts` host lives with the app, which registers it. */
const namedHosts = new Map<ChartHostName, () => Promise<ChartHostModule>>([
	["logs-volume", () => import("./logs-volume-host")],
])

/** The first registration of a name wins; a later one is ignored. */
export const registerChartHost = (name: ChartHostName, load: () => Promise<ChartHostModule>): void => {
	if (!namedHosts.has(name)) namedHosts.set(name, load)
}

/**
 * `PlotFrame` + `CanvasChart`/`Chart` on the plot box: measures the box's height
 * (`useMeasuredHeight`), mounts `@tanstack/charts` into `.ts-chart-surface`, keeps the plot anchor
 * on the scene's plot rect, and follows the box's `data-chart-spec` (a MutationObserver picks up
 * each new definition). Focus and tooltip changes become Messages.
 */
export const MountChart = Mount.defineStream("MountChart", {
	args: {
		chartId: Schema.String,
		ariaLabel: Schema.String,
		renderer: ChartRenderer,
		/** Report the plot rect and time axis (`RenderedPlot`) for an overlay. */
		reportPlot: Schema.Boolean,
		/** A host registered under this name (`registerChartHost`) instead of the full one. */
		host: Schema.optional(ChartHostName),
	},
	messages: [
		Message.CompletedMountChart,
		Message.FailedMountChart,
		Message.RenderedPlot,
		Message.ChangedChartFocus,
		Message.ChangedChartTooltip,
		Message.ToggledLegendSeries,
	],
	execute: ({ element, chartId, ariaLabel, renderer, reportPlot, host: hostKind }) => {
		const loadHost = hostKind === undefined ? () => import("./chart-host") : namedHosts.get(hostKind)
		if (loadHost === undefined) {
			return Stream.concat(Stream.make(failed(`chart host "${hostKind}" not registered`)), Stream.never)
		}
		return Stream.callback<ChartMountMessage>((queue) =>
			Effect.acquireRelease(
				Effect.tryPromise({
					try: loadHost,
					catch: (cause) => new ChartMountError({ message: String(cause), cause }),
				}).pipe(
					Effect.flatMap(({ createChartHost }) =>
						Effect.try({
							try: () => {
								const host = element.querySelector<HTMLElement>(".ts-chart-host")
								const surface = host?.querySelector<HTMLElement>(".ts-chart-surface")
								const anchor = element.querySelector<HTMLElement>("[data-chart-plot]")
								const initialSpec = decodeChartSpec(
									element.getAttribute(CHART_SPEC_ATTRIBUTE),
								)
								if (!host || !surface || Option.isNone(initialSpec)) {
									Queue.offerUnsafe(queue, failed("chart host or spec missing"))
									return () => undefined
								}

								// The last geometry sent: `onRender` runs on every pointer tick, a Message only on change.
								const sent = { key: "" }
								// A chart without a time x scale (a pie) reports its rect with an empty domain.
								const NO_AXIS = {
									domainStartMs: 0,
									domainEndMs: 0,
									rangeStart: 0,
									rangeEnd: 0,
								}
								const reportPlotOnce = (
									bounds: ChartBounds,
									timeAxis: Option.Option<TimeAxis>,
								) =>
									Option.map(
										Option.orElseSome(timeAxis, () => NO_AXIS),
										(axis) => {
											const plot = {
												x: bounds.x,
												y: bounds.y,
												width: bounds.width,
												height: bounds.height,
												...axis,
											}
											const key = `${plot.x}|${plot.y}|${plot.width}|${plot.height}|${plot.domainStartMs}|${plot.domainEndMs}|${plot.rangeStart}|${plot.rangeEnd}`
											if (key === sent.key) return
											sent.key = key
											Queue.offerUnsafe(queue, Message.RenderedPlot({ plot }))
										},
									)
								const create = (spec: typeof initialSpec.value, height: number): ChartHost =>
									Option.getOrElse(
										createChartHost(surface, spec, height, {
											ariaLabel: () =>
												element.getAttribute(CHART_LABEL_ATTRIBUTE) ?? ariaLabel,
											idPrefix: `ts-chart-${chartId}`,
											renderer,
											callbacks: {
												onFocusChange: (maybeKey) =>
													Queue.offerUnsafe(
														queue,
														Message.ChangedChartFocus({ maybeKey }),
													),
												onTooltipChange: (maybeTooltip) =>
													Queue.offerUnsafe(
														queue,
														Message.ChangedChartTooltip({ maybeTooltip }),
													),
												onLegendToggle: (key, keys) =>
													Queue.offerUnsafe(
														queue,
														Message.ToggledLegendSeries({ key, keys }),
													),
												onRender: (bounds, timeAxis) => {
													if (reportPlot) reportPlotOnce(bounds, timeAxis)
													if (!anchor) return
													anchor.style.transform = `translate(${bounds.x}px, ${bounds.y}px)`
													anchor.style.width = `${bounds.width}px`
													anchor.style.height = `${bounds.height}px`
												},
											},
										}),
										() => {
											// The host has no definition for this spec: report it and draw nothing.
											Queue.offerUnsafe(
												queue,
												failed(`no chart definition for ${spec._tag}`),
											)
											return { update: () => false, destroy: () => undefined }
										},
									)
								// NOTE: mounted at the fallback height and then corrected (chart first, then the frame's
								// measurement); the first scene shapes the canvas state.
								host.style.height = `${FALLBACK_HEIGHT}px`
								// The live handle and what it was last drawn from; local to this Mount's lifetime.
								const state = {
									height: FALLBACK_HEIGHT,
									chart: create(initialSpec.value, FALLBACK_HEIGHT),
								}
								// Measured with the fallback drawn: a flex item's
								// automatic minimum then holds a fixed-height box at its height instead of shrinking.
								const measured = Math.round(element.getBoundingClientRect().height)

								const redraw = (spec: typeof initialSpec.value) => {
									if (state.chart.update(spec, state.height)) return
									state.chart.destroy()
									state.chart = create(spec, state.height)
								}
								if (measured > 0 && measured !== FALLBACK_HEIGHT) {
									state.height = measured
									host.style.height = `${measured}px`
									redraw(initialSpec.value)
								}
								const resizeObserver = new ResizeObserver((entries) => {
									const next = Math.round(entries[0]?.contentRect.height ?? 0)
									if (next <= 0 || next === state.height) return
									state.height = next
									host.style.height = `${next}px`
									Option.map(
										decodeChartSpec(element.getAttribute(CHART_SPEC_ATTRIBUTE)),
										redraw,
									)
								})
								resizeObserver.observe(element)
								const specObserver = new MutationObserver(() =>
									Option.map(
										decodeChartSpec(element.getAttribute(CHART_SPEC_ATTRIBUTE)),
										redraw,
									),
								)
								specObserver.observe(element, {
									attributes: true,
									attributeFilter: [CHART_SPEC_ATTRIBUTE, CHART_LABEL_ATTRIBUTE],
								})

								Queue.offerUnsafe(queue, Message.CompletedMountChart())
								return () => {
									specObserver.disconnect()
									resizeObserver.disconnect()
									state.chart.destroy()
								}
							},
							catch: (cause) => new ChartMountError({ message: String(cause), cause }),
						}),
					),
					Effect.catch((error) =>
						Effect.sync(() => {
							Queue.offerUnsafe(queue, failed(error.message))
							return () => undefined
						}),
					),
				),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		)
	},
})

/**
 * `createPortal(renderTooltipBody(...), target.element)`: moves the tooltip body the view renders
 * into the body element the library's tooltip shell created in this chart's surface.
 */
export const PortalTooltipBody = Mount.define("PortalTooltipBody", {
	messages: [Message.CompletedPortalTooltipBody],
	execute: ({ element }) =>
		Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					element.parentElement
						?.closest(`[${PLOT_BOX_ATTRIBUTE}]`)
						?.querySelector(".ts-chart-tooltip__body")
						?.appendChild(element),
				),
				() => Effect.sync(() => element.remove()),
			)
			return Message.CompletedPortalTooltipBody()
		}),
})

/** `useContainerSize(containerRef)`: the container's rounded width, on mount and on every resize. */
export const MeasureChartContainer = Mount.defineStream("MeasureChartContainer", {
	messages: [Message.ResizedChartContainer],
	execute: ({ element }) =>
		Stream.callback<typeof Message.ResizedChartContainer.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const last = { width: -1, height: -1 }
					const apply = (width: number, height: number) => {
						const size = { width: Math.round(width), height: Math.round(height) }
						if (size.width === last.width && size.height === last.height) return
						last.width = size.width
						last.height = size.height
						Queue.offerUnsafe(queue, Message.ResizedChartContainer(size))
					}
					const box = element.getBoundingClientRect()
					apply(box.width, box.height)
					const observer = new ResizeObserver((entries) =>
						apply(entries[0]?.contentRect.width ?? 0, entries[0]?.contentRect.height ?? 0),
					)
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

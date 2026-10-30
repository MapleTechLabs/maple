import { TONE_BORDER, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { chartSkeleton, type ChartSkeletonVariant } from "./chart-skeleton"

// Port of `ChartLoading`, `ChartEmpty` and `ChartError` (packages/ui/src/components/charts/_shared/
// chart-state.tsx), standalone (no `ChartPlotArea`): an explicit height, else the parent owns it.

const MESSAGE_BASE = "flex items-center justify-center px-3 text-center font-mono text-2xs"

const stateBox = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ height?: number; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			h.Class(cn("w-full", options.height === undefined && "h-full", options.className)),
			...(options.height === undefined ? [] : [h.Style({ height: `${options.height}px` })]),
		],
		children,
	)

const svgAttrs = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, value))

/** `EmptyAxes`: three gridlines and a dashed baseline, masked out behind the message. */
const emptyAxes = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		svgAttrs(h, {
			"aria-hidden": "true",
			viewBox: "0 0 100 100",
			preserveAspectRatio: "none",
			class: "pointer-events-none absolute inset-0 h-full w-full [mask-image:radial-gradient(ellipse_at_center,transparent_25%,black_75%)]",
		}),
		[
			...[20, 44, 68].map((y) =>
				h.line(
					svgAttrs(h, {
						x1: "0",
						y1: String(y),
						x2: "100",
						y2: String(y),
						stroke: "currentColor",
						"stroke-opacity": "0.14",
						"stroke-width": "1",
						"vector-effect": "non-scaling-stroke",
					}),
				),
			),
			h.line(
				svgAttrs(h, {
					x1: "0",
					y1: "92",
					x2: "100",
					y2: "92",
					stroke: "currentColor",
					"stroke-opacity": "0.4",
					"stroke-width": "1",
					"stroke-dasharray": "3 4",
					"vector-effect": "non-scaling-stroke",
				}),
			),
		],
	)

/** `ChartEmpty`: an ordinary "nothing to draw" outcome, muted. */
export const chartEmpty = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ hint?: string; height?: number; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	stateBox(
		h,
		{
			height: options.height,
			className: cn(MESSAGE_BASE, "relative text-muted-foreground", options.className),
		},
		[
			emptyAxes(h),
			h.div(
				[h.Class("relative flex flex-col items-center gap-1")],
				[
					h.span([h.Class("text-foreground-soft")], children),
					...(options.hint === undefined
						? []
						: [h.span([h.Class("text-3xs text-foreground-subtle")], [options.hint])]),
				],
			),
		],
	)

/** `ChartError`: a chart whose query failed. */
export const chartError = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ height?: number; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	stateBox(
		h,
		{
			height: options.height,
			className: cn(
				MESSAGE_BASE,
				"border bg-severity-error/5",
				TONE_BORDER.crit,
				TONE_TEXT.crit,
				options.className,
			),
		},
		children,
	)

/** `ChartLoading` outside a `ChartPlotArea`: an explicit height, else the parent owns it. */
export const chartLoading = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ variant: ChartSkeletonVariant; height?: number; className?: string }>,
): Html =>
	h.div(
		[
			h.Class(cn("w-full", options.height === undefined && "h-full", options.className)),
			...(options.height === undefined ? [] : [h.Style({ height: `${options.height}px` })]),
		],
		[chartSkeleton(h, options.variant)],
	)

/** `ChartPlotArea`: reserves the plot box; the states inside fill it. */
export const chartPlotArea = <M>(
	h: HtmlBuilder<M>,
	height: number,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.div(
		[
			h.Class(cn("w-full", className)),
			h.Style({ height: `${height}px` }),
			h.DataAttribute("slot", "chart-plot-area"),
		],
		children,
	)

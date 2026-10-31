import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	dropoffGhost,
	funnelGhost,
	gaugeGhost,
	hbarGhost,
	heatmapGhost,
	pathsGhost,
	pieGhost,
	statGhost,
} from "./chart-skeleton-shapes"

// Port of `ChartSkeleton` (packages/ui/src/components/charts/_shared/chart-skeleton.tsx), every
// ghost shape. `ChartLoading` is in `chart-state.ts`; the newer ghosts are in `chart-skeleton-shapes.ts`.

export type ChartSkeletonVariant =
	| "line"
	| "area"
	| "bar"
	| "histogram"
	| "heatmap"
	| "hbar"
	| "funnel"
	| "funnel-dropoff"
	| "paths"
	| "pie"
	| "gauge"
	| "stat"

const STROKE = "var(--muted-foreground)"
const TREND = "M 2 72 L 20 52 L 38 64 L 56 30 L 74 46 L 98 16"

const attrs = <M>(h: HtmlBuilder<M>, entries: ReadonlyArray<readonly [string, string]>) =>
	entries.map(([name, value]) => h.Attribute(name, value))

const gridLines = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> =>
	[28, 52, 76].map((y) =>
		h.line(
			attrs(h, [
				["x1", "0"],
				["y1", String(y)],
				["x2", "100"],
				["y2", String(y)],
				["stroke", STROKE],
				["stroke-opacity", "0.12"],
				["stroke-width", "1"],
				["vector-effect", "non-scaling-stroke"],
			]),
		),
	)

const trendLine = <M>(h: HtmlBuilder<M>): Html =>
	h.path(
		attrs(h, [
			["d", TREND],
			["fill", "none"],
			["stroke", STROKE],
			["stroke-opacity", "0.5"],
			["stroke-width", "2"],
			["stroke-linecap", "round"],
			["stroke-linejoin", "round"],
			["vector-effect", "non-scaling-stroke"],
		]),
	)

/** The line and area ghosts: grid lines, the trend, and the area fill under it. */
const trendGhost = <M>(h: HtmlBuilder<M>, variant: "line" | "area"): Html =>
	h.svg(
		attrs(h, [
			["viewBox", "0 0 100 100"],
			["preserveAspectRatio", "none"],
			["class", "h-full w-full p-1"],
		]),
		[
			...gridLines(h),
			...(variant === "area"
				? [
						h.path(
							attrs(h, [
								["d", `${TREND} L 98 100 L 2 100 Z`],
								["fill", STROKE],
								["fill-opacity", "0.12"],
							]),
						),
					]
				: []),
			trendLine(h),
		],
	)

const BAR_HEIGHTS = [46, 70, 34, 86, 56, 96, 62]
const HISTOGRAM_HEIGHTS = [14, 28, 46, 68, 86, 96, 84, 64, 42, 26, 13]

/** `Bars`: ghost columns. */
const bars = <M>(h: HtmlBuilder<M>, heights: ReadonlyArray<number>) =>
	heights.map((height) =>
		h.div([h.Class("flex-1 rounded-xs bg-foreground/15"), h.Style({ height: `${height}%` })]),
	)

const barGhost = <M>(h: HtmlBuilder<M>, variant: "bar" | "histogram"): Html =>
	variant === "bar"
		? h.div([h.Class("flex h-full w-full items-end gap-1.5 p-3")], bars(h, BAR_HEIGHTS))
		: h.div([h.Class("flex h-full w-full items-end gap-[3px] p-3")], bars(h, HISTOGRAM_HEIGHTS))

const ghostOf = <M>(h: HtmlBuilder<M>, variant: ChartSkeletonVariant): Html => {
	switch (variant) {
		case "line":
		case "area":
			return trendGhost(h, variant)
		case "bar":
		case "histogram":
			return barGhost(h, variant)
		case "heatmap":
			return heatmapGhost(h)
		case "hbar":
			return hbarGhost(h)
		case "funnel":
			return funnelGhost(h)
		case "funnel-dropoff":
			return dropoffGhost(h)
		case "paths":
			return pathsGhost(h)
		case "pie":
			return pieGhost(h)
		case "gauge":
			return gaugeGhost(h)
		case "stat":
			return statGhost(h)
	}
}

/** `ChartSkeleton`: the ghost shape matching what will replace it, under one shared sweep. */
export const chartSkeleton = <M>(
	h: HtmlBuilder<M>,
	variant: ChartSkeletonVariant,
	className?: string,
): Html =>
	h.div(
		[
			h.Class(
				cn(
					"chart-skeleton relative flex h-full w-full items-center justify-center overflow-hidden",
					className,
				),
			),
			h.DataAttribute("slot", "chart-skeleton"),
			h.AriaHidden(true),
		],
		[ghostOf(h, variant)],
	)

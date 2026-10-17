import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of `ChartSkeleton` (packages/ui/src/components/charts/_shared/chart-skeleton.tsx) and
// `ChartLoading` (chart-state.tsx), the line and area variants.
// TODO(variants): bar, histogram, heatmap, hbar, funnel, paths, pie, gauge and stat ghosts.

export type ChartSkeletonVariant = "line" | "area"

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
			["stroke-opacity", "0.55"],
			["stroke-width", "2"],
			["stroke-linecap", "round"],
			["stroke-linejoin", "round"],
			["vector-effect", "non-scaling-stroke"],
			["pathLength", "100"],
			["class", "skeleton-draw"],
		]),
	)

export const chartSkeleton = <M>(
	h: HtmlBuilder<M>,
	variant: ChartSkeletonVariant,
	className?: string,
): Html =>
	h.div(
		[
			h.Class(cn("relative flex h-full w-full items-center justify-center overflow-hidden", className)),
			h.DataAttribute("slot", "chart-skeleton"),
			h.AriaHidden(true),
		],
		[
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
										["fill-opacity", "0.1"],
									]),
								),
							]
						: []),
					trendLine(h),
				],
			),
		],
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

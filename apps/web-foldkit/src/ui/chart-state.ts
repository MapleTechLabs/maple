import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of `ChartLoading` (packages/ui/src/components/charts/_shared/chart-state.tsx) and the
// bar-shaped variants of `ChartSkeleton` (chart-skeleton.tsx). Other variants are not ported yet.

export type ChartSkeletonVariant = "bar" | "histogram"

const BAR_HEIGHTS = [46, 70, 34, 86, 56, 96, 62]
const HISTOGRAM_HEIGHTS = [14, 28, 46, 68, 86, 96, 84, 64, 42, 26, 13]

/** `Bars`: ghost columns with staggered pulse delays. */
const bars = <M>(h: HtmlBuilder<M>, heights: ReadonlyArray<number>, delay: (index: number) => number) =>
	heights.map((height, index) =>
		h.div([
			h.Class("flex-1 rounded-xs bg-foreground/10 skeleton-bar"),
			h.Style({ height: `${height}%`, "animation-delay": `${delay(index)}s` }),
		]),
	)

const renderVariant = <M>(h: HtmlBuilder<M>, variant: ChartSkeletonVariant): Html =>
	variant === "bar"
		? h.div(
				[h.Class("flex h-full w-full items-end gap-1.5 p-3")],
				bars(h, BAR_HEIGHTS, (index) => -index * 0.13),
			)
		: h.div(
				[h.Class("flex h-full w-full items-end gap-[3px] p-3")],
				bars(
					h,
					HISTOGRAM_HEIGHTS,
					(index) => -Math.abs(index - (HISTOGRAM_HEIGHTS.length - 1) / 2) * 0.11,
				),
			)

/** `ChartSkeleton`: the ghost shape matching what will replace it. */
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
		[renderVariant(h, variant)],
	)

/** `ChartLoading` with an explicit height (no `ChartPlotArea` around it). */
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

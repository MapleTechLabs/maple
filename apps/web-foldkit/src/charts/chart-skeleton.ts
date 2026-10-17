import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of `ChartSkeleton` (packages/ui/src/components/charts/_shared/chart-skeleton.tsx), the line
// and area ghosts. TODO(skeleton-variants): bar, histogram, heatmap, paths, funnel, gauge, stat.

export type ChartSkeletonVariant = "line" | "area"

const STROKE = "var(--muted-foreground)"
const TREND = "M 2 72 L 20 52 L 38 64 L 56 30 L 74 46 L 98 16"

const attr = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, value))

const gridLines = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> =>
	[28, 52, 76].map((y) =>
		h.line(
			attr(h, {
				x1: "0",
				y1: String(y),
				x2: "100",
				y2: String(y),
				stroke: STROKE,
				"stroke-opacity": "0.12",
				"stroke-width": "1",
				"vector-effect": "non-scaling-stroke",
			}),
		),
	)

const trendLine = <M>(h: HtmlBuilder<M>): Html =>
	h.path(
		attr(h, {
			d: TREND,
			fill: "none",
			stroke: STROKE,
			"stroke-opacity": "0.55",
			"stroke-width": "2",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"vector-effect": "non-scaling-stroke",
			pathLength: "100",
			class: "skeleton-draw",
		}),
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
				attr(h, { viewBox: "0 0 100 100", preserveAspectRatio: "none", class: "h-full w-full p-1" }),
				[
					...gridLines(h),
					...(variant === "area"
						? [
								h.path(
									attr(h, {
										d: `${TREND} L 98 100 L 2 100 Z`,
										fill: STROKE,
										"fill-opacity": "0.1",
									}),
								),
							]
						: []),
					trendLine(h),
				],
			),
		],
	)

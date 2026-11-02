import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { typography } from "./typography"

const FRAMES = {
	fill: "h-full w-full aspect-auto",
	plot: "relative h-full w-full select-none",
	centered: "relative grid h-full w-full place-items-center",
} as const

/** The classes of a chart's box: `fill` is the className a host gives a chart to fill its tile instead of
 * keeping an aspect ratio, `plot` a chart's own root, `centered` its message box. */
export const chartFrameClass = (frame: keyof typeof FRAMES, className?: string): string =>
	cn(FRAMES[frame], className)

/** A chart's "No data" message, centred in the space the chart would take. */
export const chartNoData = <M>(
	h: HtmlBuilder<M>,
	options: { readonly className?: string; readonly attributes?: ReadonlyArray<Attribute<M>> } = {},
): Html =>
	h.div(
		[h.Class(chartFrameClass("centered", options.className)), ...(options.attributes ?? [])],
		[typography(h, { size: "2xs", tone: "muted" }, ["No data"])],
	)

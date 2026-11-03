import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `ScrollRegion`: the rest of a flex column's height as a plain native-scrollbar overflow region
// (`min-h-0 flex-1 overflow-y-auto`); `scrollArea` is the one with the custom scrollbar.

export type ScrollRegionOptions<M> = Readonly<{
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** A scroll region `div` filling its flex column. */
export const scrollRegion = <M>(
	h: HtmlBuilder<M>,
	options: ScrollRegionOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[h.Class(cn("min-h-0 flex-1 overflow-y-auto", options.className)), ...(options.attributes ?? [])],
		children,
	)

/** `fillRegion`: a non-scrolling box filling the rest of its flex column, the positioning context for what it holds. */
export const fillRegion = <M>(
	h: HtmlBuilder<M>,
	options: ScrollRegionOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[h.Class(cn("relative min-h-0 flex-1", options.className)), ...(options.attributes ?? [])],
		children,
	)

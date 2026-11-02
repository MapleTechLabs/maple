import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** `LaneLink`: a link row that draws its own layout but carries `listRow`'s selection lane (left
 *  bar and tint), for bespoke rail and table rows that navigate. `className` owns the look. */
export type LaneLinkOptions<M> = Readonly<{
	href: string
	isSelected: boolean
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

export const laneLink = <M>(
	h: HtmlBuilder<M>,
	options: LaneLinkOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.a(
		[
			...(options.attributes ?? []),
			h.Href(options.href),
			h.Class(cn(options.className, rowSelectedClass(options.isSelected))),
		],
		children,
	)

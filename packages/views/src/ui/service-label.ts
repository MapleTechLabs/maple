import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { middleTruncate } from "./middle-truncate"
import { hstack } from "./stack"
import { typography, type TypographySize, type TypographyTone, type TypographyWeight } from "./typography"
import { serviceDot, type ServiceDotSize } from "./values"

// Every page names a service the same way: its colour dot, then its name in the surrounding
// face. A name too long for its lane truncates and keeps the whole name in `title`.

export type ServiceLabelTruncate = "end" | "middle" | "none"

export type ServiceLabelOptions<M> = Readonly<{
	serviceName: string
	/** The dot's size; `lg` sits beside a page title. */
	dot?: ServiceDotSize
	size?: TypographySize
	tone?: TypographyTone
	weight?: TypographyWeight
	/** `end` (the default) ellipsizes the tail, `middle` keeps the tail readable, `none` never cuts. */
	truncate?: ServiceLabelTruncate
	/** Layout only: the lane's width, `shrink-0`, margins. */
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** A service as every page names it: the colour dot and the name, the full name on hover when it truncates. */
export const serviceLabel = <M>(
	h: HtmlBuilder<M>,
	options: ServiceLabelOptions<M>,
	trailing: ReadonlyArray<Html> = [],
): Html => {
	const truncate = options.truncate ?? "end"
	const name =
		truncate === "middle"
			? typography(
					h,
					{ size: options.size, tone: options.tone, weight: options.weight, className: "min-w-0" },
					[middleTruncate(h, { text: options.serviceName })],
				)
			: typography(
					h,
					{
						size: options.size,
						tone: options.tone,
						weight: options.weight,
						truncate: truncate === "end",
						className: truncate === "end" ? "min-w-0" : "whitespace-nowrap",
					},
					[options.serviceName],
				)
	return hstack(
		h,
		{
			gap: "1.5",
			as: "span",
			shrink: truncate !== "none",
			className: options.className,
			attributes: [
				...(truncate === "end" ? [h.Title(options.serviceName)] : []),
				...(options.attributes ?? []),
			],
		},
		[serviceDot(h, { serviceName: options.serviceName, size: options.dot }), name, ...trailing],
	)
}

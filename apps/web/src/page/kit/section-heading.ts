import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"

// `SectionHeading`: the `title` row and the
// `eyebrow` overline.

export type SectionHeadingOptions = Readonly<{
	title: string
	/** `eyebrow`: the uppercase overline above a form group or rail section, `mb-3` below. */
	variant?: "title" | "eyebrow"
	hint?: string
	count?: Html | string
	badge?: Html
	actions?: Html
	as?: "h2" | "h3"
	/** The heading element's id, for a section `aria-labelledby` it. */
	id?: string
	className?: string
}>

export const sectionHeading = <M>(h: HtmlBuilder<M>, options: SectionHeadingOptions): Html => {
	const titleChildren = [
		options.title,
		...(options.count === undefined
			? []
			: [h.span([h.Class("ml-2 font-mono text-xs text-muted-foreground")], [options.count])]),
	]
	const titleAttributes = [
		...(options.id === undefined ? [] : [h.Id(options.id)]),
		h.Class("text-sm font-medium text-foreground"),
	]
	const heading =
		options.variant === "eyebrow"
			? eyebrow(
					h,
					{
						as: options.as ?? "h2",
						className: cn(
							"mb-3 block",
							options.actions === undefined ? options.className : "mb-0",
						),
						attributes: options.id === undefined ? [] : [h.Id(options.id)],
					},
					[
						options.title,
						...(options.count === undefined
							? []
							: [h.span([h.Class("ml-2 font-mono")], [options.count])]),
					],
				)
			: h.div(
					[
						h.Class(
							cn(
								"flex items-baseline gap-2.5",
								options.actions === undefined && options.className,
							),
						),
					],
					[
						options.as === "h3"
							? h.h3(titleAttributes, titleChildren)
							: h.h2(titleAttributes, titleChildren),
						...(options.badge === undefined ? [] : [options.badge]),
						...(options.hint
							? [h.span([h.Class("text-xs text-muted-foreground")], [options.hint])]
							: []),
					],
				)
	if (options.actions === undefined) return heading
	return h.div(
		[h.Class(cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", options.className))],
		[heading, options.actions],
	)
}

import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"

// `HeroChip`.

/** A plain-text chip titles itself with its text, so a long value stays readable. */
export const heroChip = <M>(
	h: HtmlBuilder<M>,
	content: string | ReadonlyArray<Html | string>,
	title?: string,
): Html => {
	const children = typeof content === "string" ? [content] : content
	const texts = children.filter((child): child is string => typeof child === "string")
	const derived = texts.length === children.length ? texts.join("") : undefined
	const resolvedTitle = title ?? derived
	return badge(
		h,
		{
			variant: "meta",
			size: "xs",
			mono: true,
			className: "min-w-0",
			attributes: resolvedTitle === undefined ? [] : [h.Title(resolvedTitle)],
		},
		[h.span([h.Class("min-w-0 truncate")], children)],
	)
}

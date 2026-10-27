import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"

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

const FIELD_CLASS = "min-w-0 gap-1 font-normal text-muted-foreground"

/**
 * The title row's label-and-value chip frame. A picker is bordered with hover and a caret; a
 * static chip is a borderless tint, so a scope you cannot switch never reads as a control.
 */
export const heroFieldChipClass = (isPicker: boolean): string =>
	cn(
		badgeVariants({ variant: isPicker ? "meta" : "muted", size: "xs", mono: true }),
		FIELD_CLASS,
		isPicker && "cursor-pointer transition-colors hover:text-foreground",
	)

export type HeroFieldChipOptions = Readonly<{
	label: string
	value: string
	/** "1 account" reads value first; the default is label first ("account Acme"). */
	isValueFirst?: boolean
	isPicker?: boolean
}>

/** The muted label, the value at full contrast and, for a picker, the caret. */
export const heroFieldChipParts = <M>(
	h: HtmlBuilder<M>,
	options: HeroFieldChipOptions,
): ReadonlyArray<Html> => {
	const value = h.span([h.Class("min-w-0 truncate text-foreground")], [options.value])
	// An empty label leaves the value alone, with no stray gap before it.
	const label = options.label === "" ? [] : [h.span([h.Class("shrink-0")], [options.label])]
	return [
		...(options.isValueFirst === true ? [value, ...label] : [...label, value]),
		...(options.isPicker === true
			? [icon(h, "ChevronDownIcon", { className: "size-3 shrink-0 opacity-60" })]
			: []),
	]
}

/** A static label-and-value chip, titled with its full text. */
export const heroFieldChip = <M>(h: HtmlBuilder<M>, options: Omit<HeroFieldChipOptions, "isPicker">): Html =>
	h.span(
		[
			h.Class(heroFieldChipClass(false)),
			h.DataAttribute("slot", "badge"),
			h.Title(
				options.isValueFirst === true
					? `${options.value} ${options.label}`
					: `${options.label} ${options.value}`,
			),
		],
		heroFieldChipParts(h, options),
	)

import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `Heading`: an `h1`-`h4` on the dashboard's heading ramp. `display` is a flow's hero (sign-in,
// onboarding, connect), `title` a flow step or sheet title, `section` and `subsection` a block's
// heading, `label` a quiet group label, `code` a literal message as the title (an error's text).
// `className` is for layout (truncate, margins), not type.

export type HeadingVariant = "display" | "title" | "section" | "subsection" | "label" | "code"

const VARIANT = {
	display: "font-display text-3xl font-semibold tracking-tight text-foreground",
	title: "font-display text-xl font-semibold tracking-tight text-foreground",
	section: "text-sm font-semibold text-foreground",
	subsection: "text-sm font-medium text-foreground",
	label: "text-xs font-medium text-muted-foreground",
	code: "font-mono text-lg leading-6.5 font-semibold tracking-tight text-foreground",
} as const satisfies Record<HeadingVariant, string>

export type HeadingOptions<M> = Readonly<{
	level: 1 | 2 | 3 | 4
	variant: HeadingVariant
	id?: string
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

export const heading = <M>(
	h: HtmlBuilder<M>,
	options: HeadingOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const attributes = [
		h.Class(cn(VARIANT[options.variant], options.className)),
		h.DataAttribute("slot", "heading"),
		...(options.id === undefined ? [] : [h.Id(options.id)]),
		...(options.attributes ?? []),
	]
	switch (options.level) {
		case 1:
			return h.h1(attributes, children)
		case 2:
			return h.h2(attributes, children)
		case 3:
			return h.h3(attributes, children)
		case 4:
			return h.h4(attributes, children)
	}
}

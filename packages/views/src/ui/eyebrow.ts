import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "./eyebrow.styles"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"
import { icon, type IconName } from "./icon"

export { eyebrowVariants }

export interface EyebrowOptions<Message> {
	readonly variant?: VariantProps<typeof eyebrowVariants>["variant"]
	readonly as?: "span" | "div" | "p" | "ul" | "h2" | "h3" | "h4" | "h5"
	readonly className?: string
	readonly attributes?: ReadonlyArray<Attribute<Message>>
	/** A glyph before the label, for a group whose kind reads faster as a picture. */
	readonly icon?: IconName
}

// A trailing "(hint)" often holds units or syntax (`5m`, `AND`); the mono variant's uppercasing would change its meaning.
const HINT = /^(.*\S)(\s+\(.*\))$/

/** Keeps a trailing "(hint)" out of an uppercase transform; for any uppercased label. */
export const withHint = <Message>(
	h: HtmlBuilder<Message>,
	child: Html | string,
): ReadonlyArray<Html | string> => {
	const match = typeof child === "string" ? HINT.exec(child) : null
	return match === null
		? [child]
		: [match[1] ?? "", h.span([h.Class("normal-case tracking-normal")], [match[2] ?? ""])]
}

/** `Eyebrow`: the small muted label that titles a group. */
export const eyebrow = <Message>(
	h: HtmlBuilder<Message>,
	options: EyebrowOptions<Message>,
	rawChildren: ReadonlyArray<Html | string>,
): Html => {
	const label = Arr.flatMap(rawChildren, (child) => withHint(h, child))
	// With an icon the label is one flex item, so a "(hint)" keeps its own spacing.
	const children =
		options.icon === undefined
			? label
			: [icon(h, options.icon, { size: 12, className: "shrink-0" }), h.span([], label)]
	const isInline = options.as === undefined || options.as === "span"
	const attributes = [
		h.Class(
			cn(
				eyebrowVariants({ variant: options.variant }),
				options.icon !== undefined && (isInline ? "inline-flex" : "flex"),
				options.icon !== undefined && "items-center gap-1.5",
				options.className,
			),
		),
		h.DataAttribute("slot", "eyebrow"),
		...(options.attributes ?? []),
	]
	switch (options.as) {
		case "h2":
			return h.h2(attributes, children)
		case "h3":
			return h.h3(attributes, children)
		case "h4":
			return h.h4(attributes, children)
		case "h5":
			return h.h5(attributes, children)
		case "div":
			return h.div(attributes, children)
		case "p":
			return h.p(attributes, children)
		case "ul":
			return h.ul(attributes, children)
		default:
			return h.span(attributes, children)
	}
}

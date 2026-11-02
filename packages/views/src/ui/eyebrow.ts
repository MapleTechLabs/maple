import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

export { eyebrowVariants }

export interface EyebrowOptions<Message> {
	readonly variant?: VariantProps<typeof eyebrowVariants>["variant"]
	readonly as?: "span" | "div" | "p" | "ul" | "h2" | "h3" | "h4" | "h5"
	readonly className?: string
	readonly attributes?: ReadonlyArray<Attribute<Message>>
}

// A trailing "(hint)" often holds units or syntax (`5m`, `AND`); uppercasing would change its meaning.
const HINT = /^(.*\S)(\s+\(.*\))$/

/** Keeps a trailing "(hint)" out of the uppercase transform; for any uppercased label. */
export const withHint = <Message>(
	h: HtmlBuilder<Message>,
	child: Html | string,
): ReadonlyArray<Html | string> => {
	const match = typeof child === "string" ? HINT.exec(child) : null
	return match === null
		? [child]
		: [match[1] ?? "", h.span([h.Class("normal-case tracking-normal")], [match[2] ?? ""])]
}

/** `Eyebrow`: the small uppercase overline that titles a group. */
export const eyebrow = <Message>(
	h: HtmlBuilder<Message>,
	options: EyebrowOptions<Message>,
	rawChildren: ReadonlyArray<Html | string>,
): Html => {
	const children = rawChildren.flatMap((child) => withHint(h, child))
	const attributes = [
		h.Class(cn(eyebrowVariants({ variant: options.variant }), options.className)),
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

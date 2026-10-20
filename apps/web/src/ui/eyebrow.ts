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

/** `Eyebrow`: the small uppercase overline that titles a group. */
export const eyebrow = <Message>(
	h: HtmlBuilder<Message>,
	options: EyebrowOptions<Message>,
	children: ReadonlyArray<Html | string>,
): Html => {
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

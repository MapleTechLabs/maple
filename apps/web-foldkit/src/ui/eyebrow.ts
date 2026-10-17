import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

export { eyebrowVariants }

export interface EyebrowOptions<Message> {
	readonly variant?: VariantProps<typeof eyebrowVariants>["variant"]
	readonly as?: "span" | "h2"
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
	return options.as === "h2" ? h.h2(attributes, children) : h.span(attributes, children)
}

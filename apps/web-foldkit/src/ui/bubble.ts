import { cn } from "@maple/ui/lib/utils"
import { bubbleContentStyles, bubbleGroupStyles, bubbleVariants } from "@maple/ui/styles/ui/bubble"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/bubble.tsx (reactions not ported: no caller yet).

export type BubbleVariant = NonNullable<VariantProps<typeof bubbleVariants>["variant"]>
type Children = ReadonlyArray<Html | string>

export const bubbleGroup = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div([h.DataAttribute("slot", "bubble-group"), h.Class(cn(bubbleGroupStyles, className))], children)

export const bubble = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly variant?: BubbleVariant
		readonly align?: "start" | "end"
		readonly className?: string
	},
	children: Children,
): Html => {
	const variant = options.variant ?? "default"
	return h.div(
		[
			h.DataAttribute("slot", "bubble"),
			h.DataAttribute("variant", variant),
			h.DataAttribute("align", options.align ?? "start"),
			h.Class(cn(bubbleVariants({ variant }), options.className)),
		],
		children,
	)
}

export const bubbleContent = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div([h.DataAttribute("slot", "bubble-content"), h.Class(cn(bubbleContentStyles, className))], children)

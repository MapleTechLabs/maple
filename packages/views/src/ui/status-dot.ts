import { cn } from "@maple/ui/lib/utils"
import { statusDotVariants } from "@maple/ui/styles/ui/status-dot"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

export type StatusDotOptions<Message = never> = VariantProps<typeof statusDotVariants> &
	Readonly<{
		className?: string
		/** Props spread after the defaults (`aria-hidden={false}` with a label for a meaningful dot). */
		attributes?: ReadonlyArray<Attribute<Message>>
	}>

/** `<StatusDot>`: a static, decorative status dot. */
export const statusDot = <Message>(h: HtmlBuilder<Message>, options: StatusDotOptions<Message> = {}): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class(cn(statusDotVariants({ tone: options.tone, size: options.size }), options.className)),
		h.DataAttribute("slot", "status-dot"),
		...(options.attributes ?? []),
	])

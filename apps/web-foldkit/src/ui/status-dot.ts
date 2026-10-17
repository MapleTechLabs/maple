import { cn } from "@maple/ui/lib/utils"
import { statusDotVariants } from "@maple/ui/styles/ui/status-dot"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

export type StatusDotOptions = VariantProps<typeof statusDotVariants> & Readonly<{ className?: string }>

/** `<StatusDot>`: a static, decorative status dot. */
export const statusDot = <Message>(h: HtmlBuilder<Message>, options: StatusDotOptions = {}): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class(cn(statusDotVariants({ tone: options.tone, size: options.size }), options.className)),
		h.DataAttribute("slot", "status-dot"),
	])

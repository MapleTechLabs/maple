import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { tooltipTrigger } from "./tooltip-host"

// `InfoHint`: a small question mark beside a label that explains it in the app's tooltip, on hover
// or keyboard focus. The label itself stays plain text; the cursor stays the default.

export type InfoHintOptions = Readonly<{
	/** `warning` draws a warning triangle in the warn tone, for something the reader should check. */
	variant?: "info" | "warning"
}>

export const infoHint = <M>(h: HtmlBuilder<M>, text: string, options: InfoHintOptions = {}): Html => {
	const warning = options.variant === "warning"
	return h.span(
		[
			h.Class(
				cn(
					"inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring",
					warning
						? TONE_TEXT.warn
						: "text-foreground-subtle hover:text-foreground active:text-foreground focus-visible:text-foreground",
				),
			),
			h.Tabindex(0),
			h.Role("img"),
			h.AriaLabel(text),
			h.DataAttribute("slot", "info-hint"),
			...tooltipTrigger(h, text),
		],
		[icon(h, warning ? "AlertWarningIcon" : "CircleQuestionIcon", { size: 12 })],
	)
}

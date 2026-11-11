import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { tooltipTrigger } from "./tooltip-host"

// `InfoHint`: a small question mark beside a label that explains it in the app's tooltip, on hover
// or keyboard focus. The label itself stays plain text; the cursor stays the default.

export const infoHint = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.span(
		[
			h.Class(
				"inline-flex shrink-0 items-center rounded-full text-foreground-subtle outline-none hover:text-foreground active:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
			),
			h.Tabindex(0),
			h.Role("img"),
			h.AriaLabel(text),
			h.DataAttribute("slot", "info-hint"),
			...tooltipTrigger(h, text),
		],
		[icon(h, "CircleQuestionIcon", { size: 12 })],
	)

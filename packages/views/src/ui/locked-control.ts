import type { Html, HtmlBuilder } from "foldkit/html"
import { tooltipTrigger } from "./tooltip-host"

/**
 * `LockedControl`: a control the viewer may not use, drawn disabled with the reason as its tooltip.
 * Greyed, not only dimmed, so a brand-filled control reads as unavailable; a disabled button takes
 * no pointer events, so the wrapper is the hover and focus target.
 */
export const lockedControl = <Message>(
	h: HtmlBuilder<Message>,
	reason: string,
	control: Html,
	options: Readonly<{ className?: string }> = {},
): Html =>
	h.span(
		[
			h.Class(
				`inline-flex max-w-full cursor-not-allowed *:pointer-events-none *:grayscale ${options.className ?? ""}`,
			),
			h.Tabindex(0),
			h.Role("group"),
			h.AriaLabel(reason),
			h.DataAttribute("slot", "locked-control"),
			...tooltipTrigger(h, reason),
		],
		[control],
	)

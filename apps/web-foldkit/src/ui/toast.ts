import { cn } from "@maple/ui/lib/utils"
import { toastViewportAnchoredStyles, toastViewportStyles } from "@maple/ui/styles/ui/toast"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

const viewportAttributes = <Message>(h: HtmlBuilder<Message>): ReadonlyArray<Attribute<Message>> => [
	h.AriaAtomic(false),
	h.AriaLabel("Notifications"),
	h.AriaLive("polite"),
	h.AriaRelevant("additions text"),
	h.Role("region"),
	h.Tabindex(-1),
]

/**
 * `<ToastProvider position="bottom-right"><AnchoredToastProvider>`'s empty live regions, which
 * legacy's root renders on every page. Toasts themselves are not ported yet.
 */
export const toastViewports = <Message>(h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	h.div(
		[h.DataAttribute("base-ui-portal", ""), h.DataAttribute("slot", "toast-portal-anchored")],
		[
			h.div(
				[
					...viewportAttributes(h),
					h.Class(toastViewportAnchoredStyles),
					h.DataAttribute("slot", "toast-viewport-anchored"),
				],
				[],
			),
		],
	),
	h.div(
		[h.DataAttribute("base-ui-portal", ""), h.DataAttribute("slot", "toast-portal")],
		[
			h.div(
				[
					...viewportAttributes(h),
					h.Class(cn(...toastViewportStyles)),
					h.DataAttribute("position", "bottom-right"),
					h.DataAttribute("slot", "toast-viewport"),
				],
				[],
			),
		],
	),
]

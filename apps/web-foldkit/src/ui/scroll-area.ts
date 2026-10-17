import { cn } from "@maple/ui/lib/utils"
import {
	scrollAreaStyles,
	scrollAreaViewportFadeStyles,
	scrollAreaViewportStyles,
} from "@maple/ui/styles/ui/scroll-area"
import type { Html, HtmlBuilder } from "foldkit/html"

/** Base UI hides the viewport's native scrollbar with this class and an injected rule (styles.css). */
const DISABLE_SCROLLBAR = "base-ui-disable-scrollbar"

export type ScrollAreaOptions = Readonly<{
	className?: string
	scrollFade?: boolean
	/** Base UI's `data-id` is `<root id>-viewport`. */
	idPrefix: string
}>

/**
 * `<ScrollArea>`: Base UI's root and viewport. The scrollbars render only while content overflows,
 * and the overflow variables stay 0 until a measuring Mount is needed (the shell never overflows yet).
 */
export const scrollArea = <Message>(
	h: HtmlBuilder<Message>,
	options: ScrollAreaOptions,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.Class(cn(scrollAreaStyles, options.className)),
			h.Role("presentation"),
			h.Style({
				position: "relative",
				"--scroll-area-corner-height": "0px",
				"--scroll-area-corner-width": "0px",
			}),
		],
		[
			h.div(
				[
					h.Class(
						`${cn(scrollAreaViewportStyles, options.scrollFade === true && scrollAreaViewportFadeStyles)} ${DISABLE_SCROLLBAR}`,
					),
					h.DataAttribute("id", `${options.idPrefix}-viewport`),
					h.DataAttribute("slot", "scroll-area-viewport"),
					h.Role("presentation"),
					h.Style({
						overflow: "scroll",
						"--scroll-area-overflow-x-start": "0px",
						"--scroll-area-overflow-x-end": "0px",
						"--scroll-area-overflow-y-start": "0px",
						"--scroll-area-overflow-y-end": "0px",
					}),
					h.Tabindex(-1),
				],
				children,
			),
		],
	)

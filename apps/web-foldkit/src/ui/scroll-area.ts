import { cn } from "@maple/ui/lib/utils"
import {
	scrollAreaStyles,
	scrollAreaViewportFadeStyles,
	scrollAreaViewportGutterStyles,
	scrollAreaViewportStyles,
} from "@maple/ui/styles/ui/scroll-area"
import type { Html, HtmlBuilder } from "foldkit/html"

export type ScrollAreaOptions = Readonly<{
	id: string
	className?: string
	scrollFade?: boolean
	scrollbarGutter?: boolean
}>

/**
 * `<ScrollArea>` as Base UI renders it while the content fits: root, viewport with the overflow
 * variables at 0 and no scrollbars. Overlays whose lists can overflow track it in their Mount.
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
						`${cn(
							scrollAreaViewportStyles,
							(options.scrollFade ?? false) && scrollAreaViewportFadeStyles,
							(options.scrollbarGutter ?? false) && scrollAreaViewportGutterStyles,
						)} base-ui-disable-scrollbar`,
					),
					h.DataAttribute("id", `${options.id}-viewport`),
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

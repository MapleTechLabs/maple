import { cn } from "@maple/ui/lib/utils"
import {
	scrollAreaStyles,
	scrollAreaThumbStyles,
	scrollAreaViewportFadeStyles,
	scrollAreaViewportGutterStyles,
	scrollAreaViewportStyles,
	scrollBarStyles,
} from "@maple/ui/styles/ui/scroll-area"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** Base UI hides the viewport's native scrollbar with this class and an injected rule (styles.css). */
const DISABLE_SCROLLBAR = "base-ui-disable-scrollbar"

/** What Base UI measured for a vertically overflowing viewport (scrolled to the top). */
export type ScrollAreaOverflowY = Readonly<{ endPx: number; thumbHeightPx: number }>

export type ScrollAreaOptions = Readonly<{
	className?: string
	scrollFade?: boolean
	scrollbarGutter?: boolean
	/** Base UI's `data-id` is `<root id>-viewport`. */
	idPrefix: string
	/** Renders the vertical scrollbar Base UI shows once content overflows. */
	overflowY?: ScrollAreaOverflowY
}>

const verticalScrollbar = <Message>(
	h: HtmlBuilder<Message>,
	idPrefix: string,
	overflowY: ScrollAreaOverflowY,
	state: ReadonlyArray<Attribute<Message>>,
): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class(scrollBarStyles),
			...state,
			h.DataAttribute("id", `${idPrefix}-scrollbar`),
			h.DataAttribute("orientation", "vertical"),
			h.DataAttribute("slot", "scroll-area-scrollbar"),
			h.Style({
				position: "absolute",
				"touch-action": "none",
				"user-select": "none",
				top: "0px",
				bottom: "var(--scroll-area-corner-height)",
				"inset-inline-end": "0px",
				"--scroll-area-thumb-height": `${overflowY.thumbHeightPx}px`,
			}),
		],
		[
			h.div(
				[
					h.Class(scrollAreaThumbStyles),
					h.DataAttribute("orientation", "vertical"),
					h.DataAttribute("slot", "scroll-area-thumb"),
					h.Style({
						height: "var(--scroll-area-thumb-height)",
						transform: "translate3d(0px, 0px, 0px)",
					}),
				],
				[],
			),
		],
	)

/**
 * `<ScrollArea>`: Base UI's root and viewport, plus the vertical scrollbar when `overflowY` says the
 * content overflows. The overflow values are passed in until a measuring Mount is needed.
 */
export const scrollArea = <Message>(
	h: HtmlBuilder<Message>,
	options: ScrollAreaOptions,
	children: ReadonlyArray<Html>,
): Html => {
	const { overflowY } = options
	const state =
		overflowY === undefined
			? []
			: [h.DataAttribute("has-overflow-y", ""), h.DataAttribute("overflow-y-end", "")]
	return h.div(
		[
			h.Class(cn(scrollAreaStyles, options.className)),
			...state,
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
							options.scrollFade === true && scrollAreaViewportFadeStyles,
							options.scrollbarGutter === true && scrollAreaViewportGutterStyles,
						)} ${DISABLE_SCROLLBAR}`,
					),
					...state,
					h.DataAttribute("id", `${options.idPrefix}-viewport`),
					h.DataAttribute("slot", "scroll-area-viewport"),
					h.Role("presentation"),
					h.Style({
						overflow: "scroll",
						"--scroll-area-overflow-x-start": "0px",
						"--scroll-area-overflow-x-end": "0px",
						"--scroll-area-overflow-y-start": "0px",
						"--scroll-area-overflow-y-end": `${overflowY?.endPx ?? 0}px`,
					}),
					h.Tabindex(overflowY === undefined ? -1 : 0),
				],
				children,
			),
			...(overflowY === undefined ? [] : [verticalScrollbar(h, options.idPrefix, overflowY, state)]),
		],
	)
}

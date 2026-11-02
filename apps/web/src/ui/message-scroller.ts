import { cn } from "@maple/ui/lib/utils"
import {
	messageScrollerButtonIconStyles,
	messageScrollerButtonLabelStyles,
	messageScrollerButtonStyles,
	messageScrollerContentStyles,
	messageScrollerItemStyles,
	messageScrollerStyles,
	messageScrollerViewportStyles,
} from "@maple/ui/styles/ui/message-scroller"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { icon } from "./icon"

// `MessageScroller`: a chat thread's scroll frame (root, viewport, content, keyed items) and its
// "Scroll to end" button; the host's Mount owns the autoscroll and shows the button.

type Children = ReadonlyArray<Html>

export type MessageScrollerPartOptions<M> = Readonly<{
	/** Keys the element, so a sibling it replaces (an empty state) never patches into it. */
	key?: string
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

const part =
	(styles: string, slot: string) =>
	<M>(h: HtmlBuilder<M>, options: MessageScrollerPartOptions<M>, children: Children): Html => {
		const attributes = [
			h.Class(cn(styles, options.className)),
			h.DataAttribute("slot", slot),
			...(options.attributes ?? []),
		]
		return options.key === undefined
			? h.div(attributes, children)
			: h.keyed("div")(options.key, attributes, children)
	}

export const messageScroller = part(messageScrollerStyles, "message-scroller")
export const messageScrollerViewport = part(messageScrollerViewportStyles, "message-scroller-viewport")
export const messageScrollerContent = part(messageScrollerContentStyles, "message-scroller-content")

/** One row, keyed so the scroller sees rows added, never patched in place. */
export const messageScrollerItem = <M>(
	h: HtmlBuilder<M>,
	key: string,
	options: Omit<MessageScrollerPartOptions<M>, "key">,
	children: Children,
): Html =>
	h.keyed("div")(
		key,
		[
			h.Class(cn(messageScrollerItemStyles, options.className)),
			...(options.attributes ?? []),
			h.DataAttribute("slot", "message-scroller-item"),
		],
		children,
	)

/** "Scroll to end": inert and hidden until the host's Mount marks it `data-active="true"`. */
export const messageScrollerButton = <M>(h: HtmlBuilder<M>): Html =>
	button(
		h,
		{
			variant: "secondary",
			size: "icon-sm",
			className: messageScrollerButtonStyles,
			slot: "message-scroller-button",
			attributes: [
				h.DataAttribute("active", "false"),
				h.DataAttribute("direction", "end"),
				h.DataAttribute("size", "icon-sm"),
				h.DataAttribute("variant", "secondary"),
				h.Attribute("inert", ""),
				h.Tabindex(-1),
			],
		},
		[
			icon(h, "ArrowDownIcon", { className: messageScrollerButtonIconStyles }),
			h.span([h.Class(messageScrollerButtonLabelStyles)], ["Scroll to end"]),
		],
	)

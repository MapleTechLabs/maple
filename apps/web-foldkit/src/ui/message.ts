import { cn } from "@maple/ui/lib/utils"
import {
	messageAvatarStyles,
	messageContentStyles,
	messageFooterStyles,
	messageGroupStyles,
	messageHeaderStyles,
	messageStyles,
} from "@maple/ui/styles/ui/message"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/message.tsx: one chat message (avatar, header, bubbles).

type Children = ReadonlyArray<Html | string>

const slotDiv = <M>(
	h: HtmlBuilder<M>,
	slot: string,
	styles: string,
	children: Children,
	className?: string,
) => h.div([h.DataAttribute("slot", slot), h.Class(cn(styles, className))], children)

export const messageGroup = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	slotDiv(h, "message-group", messageGroupStyles, children, className)

export const message = <M>(
	h: HtmlBuilder<M>,
	options: { readonly align?: "start" | "end"; readonly className?: string },
	children: Children,
): Html =>
	h.div(
		[
			h.DataAttribute("slot", "message"),
			h.DataAttribute("align", options.align ?? "start"),
			h.Class(cn(messageStyles, options.className)),
		],
		children,
	)

export const messageAvatar = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	slotDiv(h, "message-avatar", messageAvatarStyles, children, className)

export const messageContent = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	slotDiv(h, "message-content", messageContentStyles, children, className)

export const messageFooter = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	slotDiv(h, "message-footer", messageFooterStyles, children, className)

export const messageHeader =<M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	slotDiv(h, "message-header", messageHeaderStyles, children, className)

import type React from "react"

import { cn } from "../../lib/utils"
import {
	messageAvatarStyles,
	messageContentStyles,
	messageFooterStyles,
	messageGroupStyles,
	messageHeaderStyles,
	messageStyles,
} from "./message.styles"

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="message-group" className={cn(messageGroupStyles, className)} {...props} />
}

function Message({
	className,
	align = "start",
	...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
	return <div data-slot="message" data-align={align} className={cn(messageStyles, className)} {...props} />
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="message-avatar" className={cn(messageAvatarStyles, className)} {...props} />
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="message-content" className={cn(messageContentStyles, className)} {...props} />
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="message-header" className={cn(messageHeaderStyles, className)} {...props} />
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="message-footer" className={cn(messageFooterStyles, className)} {...props} />
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader }

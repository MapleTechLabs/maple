"use client"

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	scrollAreaStyles,
	scrollAreaThumbStyles,
	scrollAreaViewportFadeStyles,
	scrollAreaViewportGutterStyles,
	scrollAreaViewportStyles,
	scrollBarStyles,
} from "./scroll-area.styles"

export function ScrollArea({
	className,
	children,
	scrollFade = false,
	scrollbarGutter = false,
	...props
}: ScrollAreaPrimitive.Root.Props & {
	scrollFade?: boolean
	scrollbarGutter?: boolean
}): React.ReactElement {
	return (
		<ScrollAreaPrimitive.Root className={cn(scrollAreaStyles, className)} {...props}>
			<ScrollAreaPrimitive.Viewport
				className={cn(
					scrollAreaViewportStyles,
					scrollFade && scrollAreaViewportFadeStyles,
					scrollbarGutter && scrollAreaViewportGutterStyles,
				)}
				data-slot="scroll-area-viewport"
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar orientation="vertical" />
			<ScrollBar orientation="horizontal" />
			<ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
		</ScrollAreaPrimitive.Root>
	)
}

export function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: ScrollAreaPrimitive.Scrollbar.Props): React.ReactElement {
	return (
		<ScrollAreaPrimitive.Scrollbar
			className={cn(scrollBarStyles, className)}
			data-slot="scroll-area-scrollbar"
			orientation={orientation}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb className={scrollAreaThumbStyles} data-slot="scroll-area-thumb" />
		</ScrollAreaPrimitive.Scrollbar>
	)
}

export { ScrollAreaPrimitive }

"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	popoverDescriptionStyles,
	popoverPopupStyles,
	popoverPopupTooltipStyles,
	popoverPositionerStyles,
	popoverTitleStyles,
	popoverViewportScrollStyles,
	popoverViewportStyles,
	popoverViewportTooltipStyles,
} from "./popover.styles"

export const PopoverCreateHandle: typeof PopoverPrimitive.createHandle = PopoverPrimitive.createHandle

export const Popover: typeof PopoverPrimitive.Root = PopoverPrimitive.Root

export function PopoverTrigger({
	className,
	children,
	...props
}: PopoverPrimitive.Trigger.Props): React.ReactElement {
	return (
		<PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
			{children}
		</PopoverPrimitive.Trigger>
	)
}

export function PopoverPopup({
	children,
	className,
	side = "bottom",
	align = "center",
	sideOffset = 4,
	alignOffset = 0,
	tooltipStyle = false,
	anchor,
	portalProps,
	...props
}: PopoverPrimitive.Popup.Props & {
	portalProps?: PopoverPrimitive.Portal.Props
	side?: PopoverPrimitive.Positioner.Props["side"]
	align?: PopoverPrimitive.Positioner.Props["align"]
	sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"]
	alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"]
	tooltipStyle?: boolean
	anchor?: PopoverPrimitive.Positioner.Props["anchor"]
}): React.ReactElement {
	return (
		<PopoverPrimitive.Portal {...portalProps}>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className={popoverPositionerStyles}
				data-slot="popover-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(popoverPopupStyles, tooltipStyle && popoverPopupTooltipStyles, className)}
					data-slot="popover-popup"
					{...props}
				>
					<PopoverPrimitive.Viewport
						className={cn(
							popoverViewportStyles,
							tooltipStyle ? popoverViewportTooltipStyles : popoverViewportScrollStyles,
						)}
						data-slot="popover-viewport"
					>
						{children}
					</PopoverPrimitive.Viewport>
				</PopoverPrimitive.Popup>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	)
}

export function PopoverClose({ ...props }: PopoverPrimitive.Close.Props): React.ReactElement {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

export function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props): React.ReactElement {
	return (
		<PopoverPrimitive.Title
			className={cn(popoverTitleStyles, className)}
			data-slot="popover-title"
			{...props}
		/>
	)
}

export function PopoverDescription({
	className,
	...props
}: PopoverPrimitive.Description.Props): React.ReactElement {
	return (
		<PopoverPrimitive.Description
			className={cn(popoverDescriptionStyles, className)}
			data-slot="popover-description"
			{...props}
		/>
	)
}

export { PopoverPrimitive, PopoverPopup as PopoverContent }

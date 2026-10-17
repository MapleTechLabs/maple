"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type React from "react"
import { cn } from "../../lib/utils"
import { tooltipPopupStyles, tooltipPositionerStyles, tooltipViewportStyles } from "./tooltip.styles"

export const TooltipCreateHandle: typeof TooltipPrimitive.createHandle = TooltipPrimitive.createHandle

export const TooltipProvider: typeof TooltipPrimitive.Provider = TooltipPrimitive.Provider

export const Tooltip: typeof TooltipPrimitive.Root = TooltipPrimitive.Root

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props): React.ReactElement {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

export function TooltipPopup({
	className,
	align = "center",
	sideOffset = 4,
	side = "top",
	anchor,
	children,
	portalProps,
	...props
}: TooltipPrimitive.Popup.Props & {
	align?: TooltipPrimitive.Positioner.Props["align"]
	side?: TooltipPrimitive.Positioner.Props["side"]
	sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"]
	anchor?: TooltipPrimitive.Positioner.Props["anchor"]
	portalProps?: TooltipPrimitive.Portal.Props
}): React.ReactElement {
	// Overlay bands, all body-portalled siblings: modal surfaces (sheet, dialog,
	// drawer, alert-dialog) at z-50, transient hover surfaces (tooltip,
	// hover-card, popover) at z-55, toasts at z-60. Transient sits *above* modal
	// on purpose — a tooltip triggered from inside a drawer has to be readable.
	// Leaving them tied at z-50 makes paint order depend on portal mount order.
	return (
		<TooltipPrimitive.Portal {...portalProps}>
			<TooltipPrimitive.Positioner
				align={align}
				anchor={anchor}
				className={tooltipPositionerStyles}
				data-slot="tooltip-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<TooltipPrimitive.Popup
					className={cn(tooltipPopupStyles, className)}
					data-slot="tooltip-popup"
					{...props}
				>
					<TooltipPrimitive.Viewport className={tooltipViewportStyles} data-slot="tooltip-viewport">
						{children}
					</TooltipPrimitive.Viewport>
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	)
}

export { TooltipPrimitive, TooltipPopup as TooltipContent }

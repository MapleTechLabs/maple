"use client"

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { XmarkIcon } from "../icons"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	sheetBackdropStyles,
	sheetCloseStyles,
	sheetDescriptionStyles,
	sheetFooterBareStyles,
	sheetFooterDefaultStyles,
	sheetFooterStyles,
	sheetHeaderStyles,
	sheetPanelStyles,
	sheetPopupBottomStyles,
	sheetPopupInsetStyles,
	sheetPopupLeftStyles,
	sheetPopupRightStyles,
	sheetPopupStyles,
	sheetPopupTopStyles,
	sheetTitleStyles,
	sheetViewportBottomStyles,
	sheetViewportInsetStyles,
	sheetViewportLeftStyles,
	sheetViewportRightStyles,
	sheetViewportStyles,
	sheetViewportTopStyles,
} from "./sheet.styles"
import { Button } from "./button"
import { ScrollArea } from "./scroll-area"

export const Sheet: typeof SheetPrimitive.Root = SheetPrimitive.Root

export const SheetPortal: typeof SheetPrimitive.Portal = SheetPrimitive.Portal

export function SheetTrigger(props: SheetPrimitive.Trigger.Props): React.ReactElement {
	return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

export function SheetClose(props: SheetPrimitive.Close.Props): React.ReactElement {
	return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

export function SheetBackdrop({ className, ...props }: SheetPrimitive.Backdrop.Props): React.ReactElement {
	return (
		<SheetPrimitive.Backdrop
			className={cn(sheetBackdropStyles, className)}
			data-slot="sheet-backdrop"
			{...props}
		/>
	)
}

export function SheetViewport({
	className,
	side,
	variant = "default",
	...props
}: SheetPrimitive.Viewport.Props & {
	side?: "right" | "left" | "top" | "bottom"
	variant?: "default" | "inset"
}): React.ReactElement {
	return (
		<SheetPrimitive.Viewport
			className={cn(
				sheetViewportStyles,
				side === "bottom" && sheetViewportBottomStyles,
				side === "top" && sheetViewportTopStyles,
				side === "left" && sheetViewportLeftStyles,
				side === "right" && sheetViewportRightStyles,
				variant === "inset" && sheetViewportInsetStyles,
				className,
			)}
			data-slot="sheet-viewport"
			{...props}
		/>
	)
}

export function SheetPopup({
	className,
	children,
	showCloseButton = true,
	side = "right",
	variant = "default",
	closeProps,
	portalProps,
	...props
}: SheetPrimitive.Popup.Props & {
	showCloseButton?: boolean
	side?: "right" | "left" | "top" | "bottom"
	variant?: "default" | "inset"
	closeProps?: SheetPrimitive.Close.Props
	portalProps?: SheetPrimitive.Portal.Props
}): React.ReactElement {
	return (
		<SheetPortal {...portalProps}>
			<SheetBackdrop />
			<SheetViewport side={side} variant={variant}>
				<SheetPrimitive.Popup
					className={cn(
						sheetPopupStyles,
						side === "bottom" && sheetPopupBottomStyles,
						side === "top" && sheetPopupTopStyles,
						side === "left" && sheetPopupLeftStyles,
						side === "right" && sheetPopupRightStyles,
						variant === "inset" && sheetPopupInsetStyles,
						className,
					)}
					data-slot="sheet-popup"
					{...props}
				>
					{children}
					{showCloseButton && (
						<SheetPrimitive.Close
							aria-label="Close"
							className={sheetCloseStyles}
							render={<Button size="icon" variant="ghost" />}
							{...closeProps}
						>
							<XmarkIcon />
						</SheetPrimitive.Close>
					)}
				</SheetPrimitive.Popup>
			</SheetViewport>
		</SheetPortal>
	)
}

export function SheetHeader({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(sheetHeaderStyles, className),
		"data-slot": "sheet-header",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function SheetFooter({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"div"> & {
	variant?: "default" | "bare"
}): React.ReactElement {
	const defaultProps = {
		className: cn(
			sheetFooterStyles,
			variant === "default" && sheetFooterDefaultStyles,
			variant === "bare" && sheetFooterBareStyles,
			className,
		),
		"data-slot": "sheet-footer",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props): React.ReactElement {
	return (
		<SheetPrimitive.Title
			className={cn(sheetTitleStyles, className)}
			data-slot="sheet-title"
			{...props}
		/>
	)
}

export function SheetDescription({
	className,
	...props
}: SheetPrimitive.Description.Props): React.ReactElement {
	return (
		<SheetPrimitive.Description
			className={cn(sheetDescriptionStyles, className)}
			data-slot="sheet-description"
			{...props}
		/>
	)
}

export function SheetPanel({
	className,
	scrollFade = true,
	render,
	...props
}: useRender.ComponentProps<"div"> & {
	scrollFade?: boolean
}): React.ReactElement {
	const defaultProps = {
		className: cn(sheetPanelStyles, className),
		"data-slot": "sheet-panel",
	}

	return (
		<ScrollArea scrollFade={scrollFade}>
			{useRender({
				defaultTagName: "div",
				props: mergeProps<"div">(defaultProps, props),
				render,
			})}
		</ScrollArea>
	)
}

export { SheetPrimitive, SheetBackdrop as SheetOverlay, SheetPopup as SheetContent }

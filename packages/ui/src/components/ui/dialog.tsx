"use client"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { XmarkIcon } from "../icons"
import type React from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { ScrollArea } from "./scroll-area"
import {
	dialogBackdropStyles,
	dialogCloseStyles,
	dialogDescriptionStyles,
	dialogFooterBareStyles,
	dialogFooterDefaultStyles,
	dialogFooterStyles,
	dialogHeaderStyles,
	dialogPanelStyles,
	dialogPopupBottomStickStyles,
	dialogPopupStyles,
	dialogTitleStyles,
	dialogViewportBottomStickStyles,
	dialogViewportStyles,
} from "./dialog.styles"

export const DialogCreateHandle: typeof DialogPrimitive.createHandle = DialogPrimitive.createHandle

export const Dialog: typeof DialogPrimitive.Root = DialogPrimitive.Root

export const DialogPortal: typeof DialogPrimitive.Portal = DialogPrimitive.Portal

export function DialogTrigger(props: DialogPrimitive.Trigger.Props): React.ReactElement {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

export function DialogClose(props: DialogPrimitive.Close.Props): React.ReactElement {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

export function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props): React.ReactElement {
	return (
		<DialogPrimitive.Backdrop
			className={cn(dialogBackdropStyles, className)}
			data-slot="dialog-backdrop"
			{...props}
		/>
	)
}

export function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props): React.ReactElement {
	return (
		<DialogPrimitive.Viewport
			className={cn(dialogViewportStyles, className)}
			data-slot="dialog-viewport"
			{...props}
		/>
	)
}

export function DialogPopup({
	className,
	children,
	showCloseButton = true,
	bottomStickOnMobile = true,
	closeProps,
	portalProps,
	...props
}: DialogPrimitive.Popup.Props & {
	showCloseButton?: boolean
	bottomStickOnMobile?: boolean
	closeProps?: DialogPrimitive.Close.Props
	portalProps?: DialogPrimitive.Portal.Props
}): React.ReactElement {
	return (
		<DialogPortal {...portalProps}>
			<DialogBackdrop />
			<DialogViewport className={cn(bottomStickOnMobile && dialogViewportBottomStickStyles)}>
				<DialogPrimitive.Popup
					className={cn(
						dialogPopupStyles,
						bottomStickOnMobile && dialogPopupBottomStickStyles,
						className,
					)}
					data-slot="dialog-popup"
					{...props}
				>
					{children}
					{showCloseButton && (
						<DialogPrimitive.Close
							aria-label="Close"
							className={dialogCloseStyles}
							render={<Button size="icon" variant="ghost" />}
							{...closeProps}
						>
							<XmarkIcon />
						</DialogPrimitive.Close>
					)}
				</DialogPrimitive.Popup>
			</DialogViewport>
		</DialogPortal>
	)
}

export function DialogHeader({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(dialogHeaderStyles, className),
		"data-slot": "dialog-header",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function DialogFooter({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"div"> & {
	variant?: "default" | "bare"
}): React.ReactElement {
	const defaultProps = {
		className: cn(
			dialogFooterStyles,
			variant === "default" && dialogFooterDefaultStyles,
			variant === "bare" && dialogFooterBareStyles,
			className,
		),
		"data-slot": "dialog-footer",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props): React.ReactElement {
	return (
		<DialogPrimitive.Title
			className={cn(dialogTitleStyles, className)}
			data-slot="dialog-title"
			{...props}
		/>
	)
}

export function DialogDescription({
	className,
	...props
}: DialogPrimitive.Description.Props): React.ReactElement {
	return (
		<DialogPrimitive.Description
			className={cn(dialogDescriptionStyles, className)}
			data-slot="dialog-description"
			{...props}
		/>
	)
}

export function DialogPanel({
	className,
	scrollFade = true,
	render,
	...props
}: useRender.ComponentProps<"div"> & {
	scrollFade?: boolean
}): React.ReactElement {
	const defaultProps = {
		className: cn(dialogPanelStyles, className),
		"data-slot": "dialog-panel",
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

export { DialogPrimitive, DialogBackdrop as DialogOverlay, DialogPopup as DialogContent }

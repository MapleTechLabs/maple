"use client"

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import type React from "react"
import { cn } from "../../lib/utils"
import { Button, type ButtonProps } from "./button"
import {
	alertDialogBackdropStyles,
	alertDialogDescriptionStyles,
	alertDialogFooterBareStyles,
	alertDialogFooterDefaultStyles,
	alertDialogFooterStyles,
	alertDialogHeaderStyles,
	alertDialogMediaStyles,
	alertDialogPopupBottomStickStyles,
	alertDialogPopupStyles,
	alertDialogTitleStyles,
	alertDialogViewportBottomStickStyles,
	alertDialogViewportStyles,
} from "./alert-dialog.styles"

export const AlertDialogCreateHandle: typeof AlertDialogPrimitive.createHandle =
	AlertDialogPrimitive.createHandle

export const AlertDialog: typeof AlertDialogPrimitive.Root = AlertDialogPrimitive.Root

export const AlertDialogPortal: typeof AlertDialogPrimitive.Portal = AlertDialogPrimitive.Portal

export function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props): React.ReactElement {
	return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

export function AlertDialogBackdrop({
	className,
	...props
}: AlertDialogPrimitive.Backdrop.Props): React.ReactElement {
	return (
		<AlertDialogPrimitive.Backdrop
			className={cn(alertDialogBackdropStyles, className)}
			data-slot="alert-dialog-backdrop"
			{...props}
		/>
	)
}

export function AlertDialogViewport({
	className,
	...props
}: AlertDialogPrimitive.Viewport.Props): React.ReactElement {
	return (
		<AlertDialogPrimitive.Viewport
			className={cn(alertDialogViewportStyles, className)}
			data-slot="alert-dialog-viewport"
			{...props}
		/>
	)
}

export function AlertDialogPopup({
	className,
	bottomStickOnMobile = true,
	portalProps,
	...props
}: AlertDialogPrimitive.Popup.Props & {
	bottomStickOnMobile?: boolean
	portalProps?: AlertDialogPrimitive.Portal.Props
}): React.ReactElement {
	return (
		<AlertDialogPortal {...portalProps}>
			<AlertDialogBackdrop />
			<AlertDialogViewport className={cn(bottomStickOnMobile && alertDialogViewportBottomStickStyles)}>
				<AlertDialogPrimitive.Popup
					className={cn(
						alertDialogPopupStyles,
						bottomStickOnMobile && alertDialogPopupBottomStickStyles,
						className,
					)}
					data-slot="alert-dialog-popup"
					{...props}
				/>
			</AlertDialogViewport>
		</AlertDialogPortal>
	)
}

export function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div className={cn(alertDialogHeaderStyles, className)} data-slot="alert-dialog-header" {...props} />
	)
}

export function AlertDialogFooter({
	className,
	variant = "default",
	...props
}: React.ComponentProps<"div"> & {
	variant?: "default" | "bare"
}): React.ReactElement {
	return (
		<div
			className={cn(
				alertDialogFooterStyles,
				variant === "default" && alertDialogFooterDefaultStyles,
				variant === "bare" && alertDialogFooterBareStyles,
				className,
			)}
			data-slot="alert-dialog-footer"
			{...props}
		/>
	)
}

export function AlertDialogTitle({
	className,
	...props
}: AlertDialogPrimitive.Title.Props): React.ReactElement {
	return (
		<AlertDialogPrimitive.Title
			className={cn(alertDialogTitleStyles, className)}
			data-slot="alert-dialog-title"
			{...props}
		/>
	)
}

export function AlertDialogDescription({
	className,
	...props
}: AlertDialogPrimitive.Description.Props): React.ReactElement {
	return (
		<AlertDialogPrimitive.Description
			className={cn(alertDialogDescriptionStyles, className)}
			data-slot="alert-dialog-description"
			{...props}
		/>
	)
}

export function AlertDialogClose(props: AlertDialogPrimitive.Close.Props): React.ReactElement {
	return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />
}

export function AlertDialogAction({ className, ...props }: ButtonProps): React.ReactElement {
	return <Button className={className} data-slot="alert-dialog-action" {...props} />
}

export function AlertDialogCancel({
	className,
	variant = "outline",
	render = <Button variant={variant} />,
	...props
}: AlertDialogPrimitive.Close.Props & { variant?: ButtonProps["variant"] }): React.ReactElement {
	return (
		<AlertDialogPrimitive.Close
			className={className}
			data-slot="alert-dialog-cancel"
			render={render}
			{...props}
		/>
	)
}

export function AlertDialogMedia({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(alertDialogMediaStyles, className)} data-slot="alert-dialog-media" {...props} />
}

export {
	AlertDialogPrimitive,
	AlertDialogBackdrop as AlertDialogOverlay,
	AlertDialogPopup as AlertDialogContent,
}

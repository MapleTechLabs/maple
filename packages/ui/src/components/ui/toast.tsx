"use client"

import { Toast } from "@base-ui/react/toast"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	toastAnchoredBodyStyles,
	toastAnchoredDescriptionStyles,
	toastAnchoredIconGlyphStyles,
	toastAnchoredIconStyles,
	toastAnchoredTextStyles,
	toastAnchoredTitleStyles,
	toastBodyStyles,
	toastContentStyles,
	toastDescriptionStyles,
	toastIconGlyphStyles,
	toastIconStyles,
	toastPopupContentStyles,
	toastPopupDefaultStyles,
	toastPopupStyles,
	toastPopupTooltipContentStyles,
	toastPopupTooltipStyles,
	toastPositionerStyles,
	toastRootStyles,
	toastTextStyles,
	toastTitleStyles,
	toastViewportAnchoredStyles,
	toastViewportStyles,
	upsertReplayClassName,
} from "./toast.styles"
import { AlertWarningIcon, CircleCheckIcon, CircleInfoIcon, CircleXmarkIcon, LoaderIcon } from "../icons"
import { buttonVariants } from "./button"

const TOAST_ICONS = {
	error: CircleXmarkIcon,
	info: CircleInfoIcon,
	loading: LoaderIcon,
	success: CircleCheckIcon,
	warning: AlertWarningIcon,
} as const

type SwipeDirection = "up" | "down" | "left" | "right"

type ToastData = {
	rootProps?: Omit<
		React.ComponentProps<typeof Toast.Root>,
		"children" | "className" | "swipeDirection" | "toast"
	>
	tooltipStyle?: boolean
}

function getSwipeDirection(position: ToastPosition): SwipeDirection[] {
	const verticalDirection: SwipeDirection = position.startsWith("top") ? "up" : "down"

	if (position.includes("center")) {
		return [verticalDirection]
	}

	if (position.includes("left")) {
		return ["left", verticalDirection]
	}

	return ["right", verticalDirection]
}

function Toasts({
	position,
	portalProps,
}: {
	position: ToastPosition
	portalProps?: React.ComponentProps<typeof Toast.Portal>
}): React.ReactElement {
	const { toasts } = Toast.useToastManager()
	const swipeDirection = getSwipeDirection(position)

	return (
		<Toast.Portal data-slot="toast-portal" {...portalProps}>
			<Toast.Viewport
				className={cn(...toastViewportStyles)}
				data-position={position}
				data-slot="toast-viewport"
			>
				{toasts.map((toast) => {
					const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null
					const toastData = toast.data as ToastData | undefined

					return (
						<Toast.Root
							key={toast.id}
							className={cn(...toastRootStyles, upsertReplayClassName(toast))}
							{...toastData?.rootProps}
							data-position={position}
							swipeDirection={swipeDirection}
							toast={toast}
						>
							<Toast.Content className={toastContentStyles}>
								<div className={toastBodyStyles}>
									{Icon && (
										<div className={toastIconStyles} data-slot="toast-icon">
											<Icon className={toastIconGlyphStyles} />
										</div>
									)}

									<div className={toastTextStyles}>
										<Toast.Title className={toastTitleStyles} data-slot="toast-title" />
										<Toast.Description
											className={toastDescriptionStyles}
											data-slot="toast-description"
										/>
									</div>
								</div>
								{toast.actionProps && (
									<Toast.Action
										className={buttonVariants({ size: "xs" })}
										data-slot="toast-action"
									>
										{toast.actionProps.children}
									</Toast.Action>
								)}
							</Toast.Content>
						</Toast.Root>
					)
				})}
			</Toast.Viewport>
		</Toast.Portal>
	)
}

function AnchoredToasts({
	portalProps,
}: {
	portalProps?: React.ComponentProps<typeof Toast.Portal>
}): React.ReactElement {
	const { toasts } = Toast.useToastManager()

	return (
		<Toast.Portal data-slot="toast-portal-anchored" {...portalProps}>
			<Toast.Viewport className={toastViewportAnchoredStyles} data-slot="toast-viewport-anchored">
				{toasts.map((toast) => {
					const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null
					const toastData = toast.data as ToastData | undefined
					const tooltipStyle = toastData?.tooltipStyle ?? false
					const positionerProps = toast.positionerProps

					if (!positionerProps?.anchor) {
						return null
					}

					return (
						<Toast.Positioner
							key={toast.id}
							className={toastPositionerStyles}
							data-slot="toast-positioner"
							sideOffset={positionerProps.sideOffset ?? 4}
							toast={toast}
						>
							<Toast.Root
								className={cn(
									toastPopupStyles,
									tooltipStyle ? toastPopupTooltipStyles : toastPopupDefaultStyles,
									upsertReplayClassName(toast),
								)}
								{...toastData?.rootProps}
								data-slot="toast-popup"
								toast={toast}
							>
								{tooltipStyle ? (
									<Toast.Content className={toastPopupTooltipContentStyles}>
										<Toast.Title data-slot="toast-title" />
									</Toast.Content>
								) : (
									<Toast.Content className={toastPopupContentStyles}>
										<div className={toastAnchoredBodyStyles}>
											{Icon && (
												<div
													className={toastAnchoredIconStyles}
													data-slot="toast-icon"
												>
													<Icon className={toastAnchoredIconGlyphStyles} />
												</div>
											)}

											<div className={toastAnchoredTextStyles}>
												<Toast.Title
													className={toastAnchoredTitleStyles}
													data-slot="toast-title"
												/>
												<Toast.Description
													className={toastAnchoredDescriptionStyles}
													data-slot="toast-description"
												/>
											</div>
										</div>
										{toast.actionProps && (
											<Toast.Action
												className={buttonVariants({ size: "xs" })}
												data-slot="toast-action"
											>
												{toast.actionProps.children}
											</Toast.Action>
										)}
									</Toast.Content>
								)}
							</Toast.Root>
						</Toast.Positioner>
					)
				})}
			</Toast.Viewport>
		</Toast.Portal>
	)
}

export const toastManager: ReturnType<typeof Toast.createToastManager> = Toast.createToastManager()

export const anchoredToastManager: ReturnType<typeof Toast.createToastManager> = Toast.createToastManager()

export type ToastPosition =
	| "top-left"
	| "top-center"
	| "top-right"
	| "bottom-left"
	| "bottom-center"
	| "bottom-right"

export interface ToastProviderProps extends Toast.Provider.Props {
	position?: ToastPosition
	portalProps?: React.ComponentProps<typeof Toast.Portal>
}

export function ToastProvider({
	children,
	position = "bottom-right",
	portalProps,
	...props
}: ToastProviderProps): React.ReactElement {
	return (
		<Toast.Provider toastManager={toastManager} {...props}>
			{children}
			<Toasts portalProps={portalProps} position={position} />
		</Toast.Provider>
	)
}

export interface AnchoredToastProviderProps extends Toast.Provider.Props {
	portalProps?: React.ComponentProps<typeof Toast.Portal>
}

export function AnchoredToastProvider({
	children,
	portalProps,
	...props
}: AnchoredToastProviderProps): React.ReactElement {
	return (
		<Toast.Provider toastManager={anchoredToastManager} {...props}>
			{children}
			<AnchoredToasts portalProps={portalProps} />
		</Toast.Provider>
	)
}

export { Toast as ToastPrimitive }

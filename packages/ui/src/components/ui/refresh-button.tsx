"use client"

import type React from "react"
import { cn } from "../../lib/utils"
import { ArrowRotateAnticlockwiseIcon } from "../icons"
import { Button, type ButtonProps } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

export interface RefreshButtonProps extends Omit<ButtonProps, "onClick" | "size" | "loading" | "children"> {
	onRefresh: () => void
	/** Spins the icon and disables the button while a refresh is in flight. */
	pending?: boolean
	/** Icon only, with the label as aria-label and tooltip. */
	iconOnly?: boolean
	label?: string
	size?: "xs" | "sm" | "default"
}

/**
 * Reload-now button. The icon spins while pending (the label stays readable), which is the
 * one refresh affordance; do not hand-roll `animate-spin` on refresh icons elsewhere.
 */
export function RefreshButton({
	onRefresh,
	pending = false,
	iconOnly = false,
	label = "Refresh",
	size = "sm",
	variant = "outline",
	disabled,
	...props
}: RefreshButtonProps): React.ReactElement {
	const icon = <ArrowRotateAnticlockwiseIcon className={cn("size-3.5", pending && "animate-spin")} />
	if (iconOnly) {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-busy={pending || undefined}
							aria-label={label}
							disabled={disabled || pending}
							onClick={onRefresh}
							size={size === "default" ? "icon" : size === "sm" ? "icon-sm" : "icon-xs"}
							variant={variant}
							{...props}
						/>
					}
				>
					{icon}
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
		)
	}
	return (
		<Button
			aria-busy={pending || undefined}
			disabled={disabled || pending}
			onClick={onRefresh}
			size={size}
			variant={variant}
			{...props}
		>
			{icon}
			<span>{label}</span>
		</Button>
	)
}

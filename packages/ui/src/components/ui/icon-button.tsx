"use client"

import type React from "react"
import { Button, type ButtonProps } from "./button"
import { Kbd } from "./kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

type IconSize = "icon" | "icon-xs" | "icon-sm" | "icon-lg" | "icon-xl"

export interface IconButtonProps extends Omit<ButtonProps, "size" | "aria-label"> {
	/** Accessible name, also shown as the tooltip. */
	label: string
	size?: IconSize
	/** Keyboard shortcut rendered in the tooltip. */
	shortcut?: React.ReactNode
	/** `false` keeps the aria-label but drops the tooltip. */
	tooltip?: false
}

/** An icon-only Button that always carries a name and, by default, a tooltip. */
export function IconButton({
	label,
	size = "icon-sm",
	variant = "ghost",
	shortcut,
	tooltip,
	...props
}: IconButtonProps): React.ReactElement {
	const button = (
		<Button aria-label={label} data-slot="icon-button" size={size} variant={variant} {...props} />
	)
	if (tooltip === false) return button
	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent className="flex items-center gap-1.5">
				{label}
				{shortcut != null ? <Kbd>{shortcut}</Kbd> : null}
			</TooltipContent>
		</Tooltip>
	)
}

"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import type { VariantProps } from "class-variance-authority"
import type React from "react"
import type { Tone } from "../../lib/tone"
import { cn } from "../../lib/utils"
import { StatusDot } from "./status-dot"
import {
	filterChipCountStyles,
	filterChipDotOffStyles,
	filterChipPressedBorderStyles,
	filterChipVariants,
} from "./filter-chip.styles"

export { filterChipVariants }

export interface FilterChipProps extends Omit<
	TogglePrimitive.Props,
	"pressed" | "onPressedChange" | "children" | "className"
> {
	className?: string
	pressed: boolean
	onPressedChange: (pressed: boolean) => void
	/** Status tone for the pressed border and the leading dot. Defaults to neutral. */
	tone?: Tone
	size?: VariantProps<typeof filterChipVariants>["size"]
	/** Leading dot in the tone colour. */
	dot?: boolean
	/** Trailing count, drawn muted and tabular. */
	count?: React.ReactNode
	children?: React.ReactNode
}

export function FilterChip({
	pressed,
	onPressedChange,
	tone = "neutral",
	size,
	dot = false,
	count,
	className,
	children,
	...props
}: FilterChipProps): React.ReactElement {
	return (
		<TogglePrimitive
			pressed={pressed}
			onPressedChange={(next) => onPressedChange(next)}
			className={cn(filterChipVariants({ size }), filterChipPressedBorderStyles[tone], className)}
			data-slot="filter-chip"
			{...props}
		>
			{dot ? <StatusDot tone={tone} className={pressed ? undefined : filterChipDotOffStyles} /> : null}
			{children}
			{count != null ? <span className={filterChipCountStyles}>{count}</span> : null}
		</TogglePrimitive>
	)
}

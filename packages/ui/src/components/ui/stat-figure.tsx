import type * as React from "react"
import { cn } from "../../lib/utils"

type StatFigureSize = "sm" | "md" | "lg"

const FIGURE_VALUE: Record<StatFigureSize, string> = {
	sm: "text-xl",
	md: "text-2xl tracking-tight",
	lg: "text-[26px] tracking-[-0.01em]",
} satisfies Record<StatFigureSize, string>

const FIGURE_UNIT: Record<StatFigureSize, string> = {
	sm: "text-2xs",
	md: "text-xs",
	lg: "text-2xs",
} satisfies Record<StatFigureSize, string>

/** A headline number with a muted unit or caption riding its baseline; never wraps. */
export function StatFigure({
	value,
	unit,
	size = "md",
	mono = true,
	className,
	valueClassName,
}: {
	value: React.ReactNode
	unit?: React.ReactNode
	size?: StatFigureSize
	/** Mono figures for readouts; `false` sets the value in the display face. */
	mono?: boolean
	className?: string
	valueClassName?: string
}) {
	return (
		<span className={cn("flex items-baseline gap-1.5 whitespace-nowrap", className)}>
			<span
				className={cn(
					"font-semibold tabular-nums leading-none",
					mono ? "font-mono" : "font-display",
					FIGURE_VALUE[size],
					valueClassName,
				)}
			>
				{value}
			</span>
			{unit ? <span className={cn("text-muted-foreground", FIGURE_UNIT[size])}>{unit}</span> : null}
		</span>
	)
}

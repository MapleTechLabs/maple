import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	type StatFigureSize,
	statFigureStyles,
	statFigureUnitSizeStyles,
	statFigureUnitStyles,
	statFigureValueDisplayStyles,
	statFigureValueMonoStyles,
	statFigureValueSizeStyles,
	statFigureValueStyles,
} from "./stat-figure.styles"

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
		<span className={cn(statFigureStyles, className)}>
			<span
				className={cn(
					statFigureValueStyles,
					mono ? statFigureValueMonoStyles : statFigureValueDisplayStyles,
					statFigureValueSizeStyles[size],
					valueClassName,
				)}
			>
				{value}
			</span>
			{unit ? (
				<span className={cn(statFigureUnitStyles, statFigureUnitSizeStyles[size])}>{unit}</span>
			) : null}
		</span>
	)
}

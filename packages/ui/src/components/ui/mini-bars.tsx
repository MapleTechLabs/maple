import type * as React from "react"
import { cn } from "../../lib/utils"

const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

/**
 * Static bar sparkline in one <svg>, no chart runtime. Sized by `className`;
 * all lengths (`floor`, `minHeight`, `gap`) are percent of the box.
 */
export function MiniBars({
	values,
	color = "currentColor",
	floor = 0,
	floorColor,
	minHeight = 5,
	gap = 2,
	opacityRamp = false,
	tail,
	className,
	style,
	label,
}: {
	/** Bucket values, oldest first. Negative and non-finite values draw as zero. */
	values: ReadonlyArray<number>
	/** Raw CSS colour; defaults to `currentColor` so a text-* class can tint it. */
	color?: string
	/** Height of the tick drawn for a zero bucket; 0 leaves it blank. */
	floor?: number
	/** Fill for the zero tick; defaults to `color` at low opacity. */
	floorColor?: string
	/** Smallest height for any non-zero bucket. */
	minHeight?: number
	gap?: number
	/** Fade short bars (0.3 to 1 by share of the peak). */
	opacityRamp?: boolean
	/** Fraction of trailing bars drawn at full strength; earlier ones dim. */
	tail?: number
	className?: string
	style?: React.CSSProperties
	/** Accessible name; the bars are decorative without one. */
	label?: string
}): React.ReactElement {
	const count = values.length
	const max = count > 0 ? Math.max(...values.map(finite)) : 0
	const barWidth = Math.max((100 - gap * (count - 1)) / Math.max(count, 1), 0.5)
	const tailStart = tail === undefined ? 0 : count - Math.max(1, Math.round(count * tail))
	return (
		<svg
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
			className={cn("block", className)}
			style={style}
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			data-slot="mini-bars"
		>
			{label ? <title>{label}</title> : null}
			{values.map((raw, index) => {
				const value = finite(raw)
				const x = index * (barWidth + gap)
				const dim = index < tailStart
				if (value === 0) {
					if (floor <= 0) return null
					return (
						<rect
							key={index}
							x={x}
							y={100 - floor}
							width={barWidth}
							height={floor}
							fill={floorColor ?? color}
							opacity={floorColor ? 1 : dim ? 0.2 : 0.3}
						/>
					)
				}
				const ratio = max > 0 ? value / max : 0
				const height = Math.max(ratio * 100, minHeight)
				const opacity = (opacityRamp ? 0.3 + ratio * 0.7 : 1) * (dim ? 0.5 : 1)
				return (
					<rect
						key={index}
						x={x}
						y={100 - height}
						width={barWidth}
						height={height}
						fill={color}
						opacity={opacity}
					/>
				)
			})}
		</svg>
	)
}

import type * as React from "react"
import { TONE_FILL, type Tone } from "../../lib/tone"
import { cn } from "../../lib/utils"

/** Width for a fraction: clamped to 0..1, and a non-zero value is never thinner than `minVisible`%. */
function widthPercent(fraction: number, minVisible: number): number {
	if (!Number.isFinite(fraction) || fraction <= 0) return 0
	return Math.max(Math.min(fraction, 1) * 100, minVisible)
}

/**
 * Horizontal share/usage bar. Pass `value` + `max` for a share of the largest
 * row, or `value` alone as a 0..1 fraction.
 */
export function Meter({
	value,
	max = 1,
	minVisible = 1.5,
	tone,
	fillClassName,
	className,
	label,
}: {
	value: number
	max?: number
	/** Smallest visible width, in percent, for any non-zero value. */
	minVisible?: number
	/** Fill colour from the shared tone scale; `fillClassName` still wins when both are set. */
	tone?: Tone
	fillClassName?: string
	className?: string
	/** Accessible name; the bar is decorative without one. */
	label?: string
}): React.ReactElement {
	const fraction = max > 0 ? value / max : 0
	return (
		<div
			className={cn("relative h-1 min-w-0 overflow-hidden rounded-full bg-muted/60", className)}
			data-slot="meter"
			role={label ? "meter" : undefined}
			aria-label={label}
			aria-valuenow={label ? value : undefined}
			aria-valuemin={label ? 0 : undefined}
			aria-valuemax={label ? max : undefined}
			aria-hidden={label ? undefined : true}
		>
			<div
				className={cn(
					"absolute inset-y-0 left-0 rounded-[inherit] transition-[width] duration-500",
					tone ? TONE_FILL[tone] : "bg-primary/60",
					fillClassName,
				)}
				style={{ width: `${widthPercent(fraction, minVisible)}%` }}
			/>
		</div>
	)
}

export interface BarSegment {
	key: string
	value: number
	/** Fill class (`bg-severity-error`) or, with `color`, left empty. */
	className?: string
	/** Raw CSS colour for data-driven palettes. */
	color?: string
	/** Native tooltip text. */
	title?: string
}

/** Stacked composition bar: each segment's width is its share of the total. */
export function SegmentedBar({
	segments,
	total,
	minVisible = 0,
	label,
	className,
}: {
	segments: ReadonlyArray<BarSegment>
	/** Defaults to the segment sum; pass a larger total to leave the remainder empty. */
	total?: number
	/** Smallest width, in percent, for any non-zero segment. */
	minVisible?: number
	/** Accessible summary; the bar is `role="img"` with it and decorative without. */
	label?: string
	className?: string
}): React.ReactElement {
	const sum = total ?? segments.reduce((acc, s) => acc + Math.max(0, s.value), 0)
	return (
		<div
			className={cn("flex h-1.5 min-w-0 overflow-hidden rounded-full bg-muted/60", className)}
			data-slot="segmented-bar"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			{sum > 0
				? segments.map((segment) =>
						segment.value > 0 ? (
							<div
								key={segment.key}
								title={segment.title}
								className={cn("h-full transition-[width] duration-500", segment.className)}
								style={{
									width: `${Math.max((segment.value / sum) * 100, minVisible)}%`,
									backgroundColor: segment.color,
								}}
							/>
						) : null,
					)
				: null}
		</div>
	)
}

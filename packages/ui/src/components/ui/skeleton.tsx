import * as React from "react"
import { cn } from "../../lib/utils"
import {
	skeletonListGapStyles,
	skeletonListRowDefaultStyles,
	skeletonListRowStyles,
	skeletonListStyles,
	skeletonStyles,
} from "./skeleton.styles"

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(skeletonStyles, className)} data-slot="skeleton" {...props} />
}

/** A stack of identical skeleton rows: the loading state of a list or panel body. */
export function SkeletonList({
	rows = 4,
	rowClassName = skeletonListRowDefaultStyles,
	gap = "px",
	renderRow,
	label,
	className,
}: {
	rows?: number
	rowClassName?: string
	gap?: "0" | "px" | "1" | "2" | "3" | "6"
	/** Accessible name for the loading region. */
	label?: string
	/** Custom row skeleton; receives the index for staggered widths. */
	renderRow?: (index: number) => React.ReactNode
	className?: string
}): React.ReactElement {
	return (
		<div
			aria-busy
			aria-label={label}
			className={cn(skeletonListStyles, skeletonListGapStyles[gap], className)}
			data-slot="skeleton-list"
		>
			{Array.from({ length: rows }, (_, i) =>
				renderRow ? (
					<React.Fragment key={i}>{renderRow(i)}</React.Fragment>
				) : (
					<Skeleton key={i} className={cn(skeletonListRowStyles, rowClassName)} />
				),
			)}
		</div>
	)
}

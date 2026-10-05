import * as React from "react"
import { cn } from "../../lib/utils"

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(
				// The sweep lives on a transform-animated pseudo-element so it stays on the
				// compositor — animating background-position on a `fixed`-attachment gradient
				// repaints every skeleton per frame and visibly lags busy loading screens.
				"relative isolate overflow-hidden rounded-sm bg-muted before:absolute before:inset-0 before:animate-skeleton before:[background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] [--skeleton-highlight:--alpha(var(--color-white)/64%)] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)] motion-reduce:before:animate-none",
				className,
			)}
			data-slot="skeleton"
			{...props}
		/>
	)
}

/** A stack of identical skeleton rows: the loading state of a list or panel body. */
export function SkeletonList({
	rows = 4,
	rowClassName = "h-8",
	gap = "px",
	renderRow,
	className,
}: {
	rows?: number
	rowClassName?: string
	gap?: "px" | "1" | "2" | "3"
	/** Custom row skeleton; receives the index for staggered widths. */
	renderRow?: (index: number) => React.ReactNode
	className?: string
}): React.ReactElement {
	return (
		<div
			aria-busy
			className={cn(
				"flex flex-col",
				gap === "px" ? "gap-px" : gap === "1" ? "gap-1" : gap === "2" ? "gap-2" : "gap-3",
				className,
			)}
			data-slot="skeleton-list"
		>
			{Array.from({ length: rows }, (_, i) =>
				renderRow ? (
					<React.Fragment key={i}>{renderRow(i)}</React.Fragment>
				) : (
					<Skeleton key={i} className={cn("w-full", rowClassName)} />
				),
			)}
		</div>
	)
}

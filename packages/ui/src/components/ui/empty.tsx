import type { VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	emptyContentStyles,
	emptyDescriptionStyles,
	emptyHeaderStyles,
	emptyMediaStackLeftStyles,
	emptyMediaStackRightStyles,
	emptyMediaStyles,
	emptyMediaVariants,
	emptyMessageDashedStyles,
	emptyMessageStyles,
	emptyStyles,
	emptyTitleStyles,
} from "./empty.styles"

export function Empty({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(emptyStyles, className)} data-slot="empty" {...props} />
}

export function EmptyHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(emptyHeaderStyles, className)} data-slot="empty-header" {...props} />
}

export function EmptyMedia({
	className,
	variant = "default",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>): React.ReactElement {
	return (
		<div
			className={cn(emptyMediaStyles, className)}
			data-slot="empty-media"
			data-variant={variant}
			{...props}
		>
			{variant === "icon" && (
				<>
					<div
						aria-hidden="true"
						className={cn(emptyMediaVariants({ className, variant }), emptyMediaStackLeftStyles)}
					/>
					<div
						aria-hidden="true"
						className={cn(emptyMediaVariants({ className, variant }), emptyMediaStackRightStyles)}
					/>
				</>
			)}
			<div className={cn(emptyMediaVariants({ className, variant }))} {...props} />
		</div>
	)
}

export function EmptyTitle({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(emptyTitleStyles, className)} data-slot="empty-title" {...props} />
}

export function EmptyDescription({ className, ...props }: React.ComponentProps<"p">): React.ReactElement {
	return <div className={cn(emptyDescriptionStyles, className)} data-slot="empty-description" {...props} />
}

export function EmptyContent({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(emptyContentStyles, className)} data-slot="empty-content" {...props} />
}

// The compact in-panel "nothing here" line: a table with no rows, a chart with no series.
// `dashed` frames it as a placeholder box. Use `Empty` for page-level states with media and actions.
export function EmptyMessage({
	className,
	dashed,
	...props
}: React.ComponentProps<"div"> & { dashed?: boolean }): React.ReactElement {
	return (
		<div
			className={cn(emptyMessageStyles, dashed && emptyMessageDashedStyles, className)}
			data-slot="empty-message"
			{...props}
		/>
	)
}

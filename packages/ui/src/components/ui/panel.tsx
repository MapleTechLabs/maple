import type * as React from "react"
import { cn } from "../../lib/utils"

/**
 * Flat bordered section frame (charts, side lists, detail sections). `Card` is
 * the raised, rounded-2xl surface for standalone content; a panel sits inside
 * a page grid and stays quiet.
 */
export function Panel({ className, ...props }: React.ComponentProps<"section">): React.ReactElement {
	return (
		<section
			className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border bg-card", className)}
			data-slot="panel"
			{...props}
		/>
	)
}

/** Header strip: title (+ scope marker) on the left, an action or legend on the right. */
export function PanelHeader({
	title,
	scope,
	action,
	divided = true,
	className,
	children,
}: {
	title?: React.ReactNode
	/** Marker beside the title saying what the panel is filtered to. */
	scope?: React.ReactNode
	action?: React.ReactNode
	/** Bottom border under the strip. Chart panels turn it off so the plot runs up to the title. */
	divided?: boolean
	className?: string
	children?: React.ReactNode
}): React.ReactElement {
	return (
		<header
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5",
				divided ? "border-b" : "pb-0",
				className,
			)}
			data-slot="panel-header"
		>
			{children ?? (
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<PanelTitle>{title}</PanelTitle>
					{scope}
				</div>
			)}
			{action ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{action}</div> : null}
		</header>
	)
}

export function PanelTitle({ className, ...props }: React.ComponentProps<"h3">): React.ReactElement {
	return (
		<h3
			className={cn("truncate text-[11px] font-medium text-muted-foreground", className)}
			data-slot="panel-title"
			{...props}
		/>
	)
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn("min-h-0 flex-1", className)} data-slot="panel-body" {...props} />
}

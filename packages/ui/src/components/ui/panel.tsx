import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type * as React from "react"
import { cn } from "../../lib/utils"

const PANEL_TONE = {
	default: "bg-card",
	muted: "bg-muted/40",
	background: "bg-background",
} as const

const PANEL_PADDING = {
	sm: "p-3",
	md: "p-4",
} as const

export type PanelTone = keyof typeof PANEL_TONE

/**
 * Flat bordered section frame (charts, side lists, detail sections). `Card` is
 * the raised, rounded-2xl surface for standalone content; a panel sits inside
 * a page grid and stays quiet. `rounded-md` is the one panel radius.
 */
export function Panel({
	className,
	padded = false,
	tone = "default",
	render,
	...props
}: useRender.ComponentProps<"section"> & {
	/** Inner padding: `true` is `p-4`, `"sm"` is `p-3`. Off for panels with a `PanelHeader`. */
	padded?: boolean | "sm"
	/** Surface fill: `muted` for a recessed well, `background` for a frame on a card. */
	tone?: PanelTone
}): React.ReactElement {
	const defaultProps = {
		className: cn(
			"flex min-w-0 flex-col overflow-hidden rounded-md border",
			PANEL_TONE[tone],
			padded === "sm" ? PANEL_PADDING.sm : padded ? PANEL_PADDING.md : null,
			className,
		),
		"data-slot": "panel",
	}
	return useRender({ defaultTagName: "section", props: mergeProps<"section">(defaultProps, props), render })
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
			className={cn("truncate text-2xs font-medium text-muted-foreground", className)}
			data-slot="panel-title"
			{...props}
		/>
	)
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn("min-h-0 flex-1", className)} data-slot="panel-body" {...props} />
}

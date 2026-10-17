import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	panelBodyStyles,
	panelHeaderActionStyles,
	panelHeaderDividedStyles,
	panelHeaderStyles,
	panelHeaderTitleRowStyles,
	panelHeaderUndividedStyles,
	panelPaddingStyles,
	panelStyles,
	panelTitleStyles,
	panelToneStyles,
} from "./panel.styles"

export type PanelTone = keyof typeof panelToneStyles

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
			panelStyles,
			panelToneStyles[tone],
			padded === "sm" ? panelPaddingStyles.sm : padded ? panelPaddingStyles.md : null,
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
				panelHeaderStyles,
				divided ? panelHeaderDividedStyles : panelHeaderUndividedStyles,
				className,
			)}
			data-slot="panel-header"
		>
			{children ?? (
				<div className={panelHeaderTitleRowStyles}>
					<PanelTitle>{title}</PanelTitle>
					{scope}
				</div>
			)}
			{action ? <div className={panelHeaderActionStyles}>{action}</div> : null}
		</header>
	)
}

export function PanelTitle({ className, ...props }: React.ComponentProps<"h3">): React.ReactElement {
	return <h3 className={cn(panelTitleStyles, className)} data-slot="panel-title" {...props} />
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(panelBodyStyles, className)} data-slot="panel-body" {...props} />
}

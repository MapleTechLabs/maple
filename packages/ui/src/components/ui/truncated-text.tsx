"use client"

import * as React from "react"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

/**
 * Single-line text that truncates with an ellipsis and reveals the full value
 * on hover. `tooltip="overflow"` uses a styled Tooltip shown only when the
 * text is actually cut off; `"title"` uses the native attribute.
 */
export function TruncatedText({
	children,
	text,
	mono = false,
	tooltip = "title",
	className,
	style,
}: {
	children?: React.ReactNode
	/** The full string for the hover text; defaults to `children` when it is a string. */
	text?: string
	mono?: boolean
	tooltip?: "title" | "overflow" | "none"
	className?: string
	style?: React.CSSProperties
}): React.ReactElement {
	const full = text ?? (typeof children === "string" ? children : undefined)
	const [clipped, setClipped] = React.useState(false)
	const classes = cn("block min-w-0 truncate", mono && "font-mono", className)

	if (tooltip !== "overflow" || !full) {
		return (
			<span className={classes} style={style} title={tooltip === "title" ? full : undefined}>
				{children ?? full}
			</span>
		)
	}

	return (
		<Tooltip open={clipped ? undefined : false}>
			<TooltipTrigger
				render={<span />}
				className={classes}
				style={style}
				onPointerEnter={(event) =>
					setClipped(event.currentTarget.scrollWidth > event.currentTarget.clientWidth)
				}
			>
				{children ?? full}
			</TooltipTrigger>
			<TooltipContent className="max-w-sm break-all">{full}</TooltipContent>
		</Tooltip>
	)
}

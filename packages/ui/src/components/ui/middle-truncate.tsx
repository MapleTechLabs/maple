import type * as React from "react"
import { cn } from "../../lib/utils"

/**
 * Single-line text that keeps its last `tail` characters visible and
 * ellipsizes the middle. For values that differ at the end: pod hashes,
 * `-eu-west-1` vs `-us-east-1`, routes, file paths, URLs. Pure CSS, the full
 * value is always in `title`.
 */
export function MiddleTruncate({
	text,
	tail = 12,
	mono = false,
	className,
}: {
	text: string
	tail?: number
	mono?: boolean
	className?: string
}): React.ReactElement {
	const chars = Array.from(text)
	const classes = cn("flex min-w-0 max-w-full", mono && "font-mono", className)
	if (chars.length <= tail * 2) {
		return (
			<span className={classes} title={text}>
				<span className="truncate">{text}</span>
			</span>
		)
	}
	return (
		<span className={classes} title={text}>
			<span className="truncate">{chars.slice(0, -tail).join("")}</span>
			<span className="shrink-0 whitespace-pre">{chars.slice(-tail).join("")}</span>
		</span>
	)
}

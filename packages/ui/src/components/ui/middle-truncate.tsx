import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	middleTruncateHeadStyles,
	middleTruncateMonoStyles,
	middleTruncateStyles,
	middleTruncateTailStyles,
} from "./middle-truncate.styles"

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
	const classes = cn(middleTruncateStyles, mono && middleTruncateMonoStyles, className)
	if (chars.length <= tail * 2) {
		return (
			<span className={classes} title={text}>
				<span className={middleTruncateHeadStyles}>{text}</span>
			</span>
		)
	}
	return (
		<span className={classes} title={text}>
			<span className={middleTruncateHeadStyles}>{chars.slice(0, -tail).join("")}</span>
			<span className={middleTruncateTailStyles}>{chars.slice(-tail).join("")}</span>
		</span>
	)
}

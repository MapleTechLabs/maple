"use client"

import type * as React from "react"
import { type IdKind, shortId } from "../../lib/ids"
import { cn } from "../../lib/utils"
import { CopyButton } from "./copy-button"

/**
 * A shortened trace/span/session id or commit SHA in mono, with the full value
 * as the native tooltip and an optional copy button.
 */
export function TruncatedId({
	value,
	kind = "generic",
	length,
	ellipsis = false,
	copy = false,
	className,
}: {
	value: string
	kind?: IdKind
	length?: number
	ellipsis?: boolean
	/** Trailing copy button for the full value. */
	copy?: boolean
	className?: string
}): React.ReactElement {
	const text = (
		<span className={cn("font-mono tabular-nums", !copy && className)} title={value}>
			{shortId(value, kind, { length, ellipsis })}
		</span>
	)
	if (!copy) return text
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
			{text}
			<CopyButton value={value} label={kind === "sha" ? "commit SHA" : `${kind} id`} size="icon-xs" />
		</span>
	)
}

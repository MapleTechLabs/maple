import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

interface SectionHeadingProps {
	title: string
	/** Muted note beside the title ("worst first"). */
	hint?: string
	/** A mono count rendered inside the heading ("Zones 12"). */
	count?: ReactNode
	/** Right-aligned controls or meta; the row wraps under the title on narrow widths. */
	actions?: ReactNode
	as?: "h2" | "h3"
	className?: string
}

/** The title row above a page section. */
export function SectionHeading({
	title,
	hint,
	count,
	actions,
	as: Heading = "h2",
	className,
}: SectionHeadingProps) {
	const heading = (
		<div className={cn("flex items-baseline gap-2.5", !actions && className)}>
			<Heading className="text-sm font-medium text-foreground">
				{title}
				{count != null ? (
					<span className="ml-2 font-mono text-xs text-muted-foreground">{count}</span>
				) : null}
			</Heading>
			{hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
		</div>
	)
	if (!actions) return heading
	return (
		<div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
			{heading}
			{actions}
		</div>
	)
}

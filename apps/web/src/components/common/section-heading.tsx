import type { ReactNode } from "react"

import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"

interface SectionHeadingProps {
	title: string
	/**
	 * `title` is the text-sm row above a page section; `eyebrow` is the uppercase overline
	 * (form sections, detail rails), spaced `mb-3` below. Pass `className="mb-0"` when inline.
	 */
	variant?: "title" | "eyebrow"
	/** Reference it from the group's `aria-labelledby`. */
	id?: string
	/** Muted note beside the title ("worst first"). */
	hint?: string
	/** A mono count rendered inside the heading ("Zones 12"). */
	count?: ReactNode
	/** Right-aligned controls or meta; the row wraps under the title on narrow widths. */
	actions?: ReactNode
	as?: "h2" | "h3"
	className?: string
}

/** The title row above a page section, or (variant="eyebrow") the overline above a form group. */
export function SectionHeading({
	title,
	variant = "title",
	id,
	hint,
	count,
	actions,
	as: Heading = "h2",
	className,
}: SectionHeadingProps) {
	const heading =
		variant === "eyebrow" ? (
			<Eyebrow as={Heading} id={id} className={cn("mb-3 block", actions ? "mb-0" : className)}>
				{title}
				{count != null ? <span className="ml-2 font-mono">{count}</span> : null}
			</Eyebrow>
		) : (
			<div className={cn("flex items-baseline gap-2.5", !actions && className)}>
				<Heading id={id} className="text-sm font-medium text-foreground">
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

// A table row that navigates is a real link: its first cell holds an anchor
// whose hit area stretches over the whole row, which gives keyboard focus,
// cmd/middle-click and "copy link" for free (a `<tr>` cannot be an `<a>`).

import type { ReactNode } from "react"
import { TableRow } from "@maple/ui/components/ui/table"
import { cn } from "@maple/ui/lib/utils"

export function LinkRow({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<TableRow
			className={cn(
				"relative cursor-pointer focus-within:bg-muted/50 has-[a[data-row-link]:focus-visible]:outline-2 has-[a[data-row-link]:focus-visible]:-outline-offset-2 has-[a[data-row-link]:focus-visible]:outline-ring",
				className,
			)}
		>
			{children}
		</TableRow>
	)
}

/** The row's anchor. Put it in the first cell; its `::after` covers the row. */
export function RowLink({
	href,
	label,
	children,
	className,
}: {
	href: string
	/** Accessible name when the visible content is not a good one. */
	label?: string
	children: ReactNode
	className?: string
}) {
	return (
		<a
			href={href}
			aria-label={label}
			data-row-link=""
			className={cn("outline-none after:absolute after:inset-0 after:content-['']", className)}
		>
			{children}
		</a>
	)
}

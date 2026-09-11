import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import { ArrowUpDownIcon } from "@/components/icons"

/**
 * Clickable column header. Sorting is server-side — the lists are paged, so
 * reordering the rows already fetched would only sort the current window.
 * `hint` explains a column whose name does not say what it measures.
 */
export function SortableHeader<K extends string>({
	label,
	sortKey,
	activeKey,
	dir,
	onSort,
	hint,
}: {
	label: string
	sortKey: K
	activeKey: K
	dir: "asc" | "desc"
	onSort: (key: K) => void
	hint?: ReactNode
}) {
	const active = activeKey === sortKey
	const className = cn(
		"inline-flex items-center gap-1 transition-colors",
		active ? "text-foreground" : "hover:text-foreground",
	)
	const onClick = () => onSort(sortKey)
	const content = (
		<>
			{label}
			<ArrowUpDownIcon
				size={10}
				className={cn(
					"transition-opacity",
					active ? "opacity-100" : "opacity-40",
					active && dir === "asc" && "rotate-180",
				)}
			/>
		</>
	)

	if (hint === undefined) {
		return (
			<button type="button" onClick={onClick} className={className}>
				{content}
			</button>
		)
	}
	return (
		<Tooltip>
			<TooltipTrigger render={<button type="button" onClick={onClick} />} className={className}>
				{content}
			</TooltipTrigger>
			<TooltipContent>{hint}</TooltipContent>
		</Tooltip>
	)
}

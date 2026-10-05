import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"

/** Titles a group of rows in the dashboard and template lists: heading, count, rule, note. */
export function ListSectionHeader({
	title,
	count,
	accent,
	note,
	className,
}: {
	title: string
	count: number
	accent?: boolean
	note?: string
	className?: string
}) {
	return (
		<div className={cn("flex items-center gap-2 pb-2", className)}>
			{/* A real heading so the groups are navigable by assistive tech. */}
			<Eyebrow variant="label" as="h3">
				{title}
			</Eyebrow>
			<span className={cn("font-mono text-[11px]", accent ? "text-primary" : "text-muted-foreground")}>
				{count}
			</span>
			<span aria-hidden className="h-px grow bg-border" />
			{note && <span className="text-muted-foreground text-[11px]">{note}</span>}
		</div>
	)
}

import { cn } from "@maple/ui/lib/utils"

interface IssueNotesCalloutProps {
	notes: string
	className?: string
}

export function IssueNotesCallout({ notes, className }: IssueNotesCalloutProps) {
	return (
		<div className={cn("relative rounded-md border border-warning/30 bg-warning/5 px-4 py-3", className)}>
			<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-warning-foreground">
				Notes
			</div>
			<div className="whitespace-pre-wrap text-sm text-foreground">{notes}</div>
		</div>
	)
}

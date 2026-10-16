import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"

interface IssueNotesCalloutProps {
	notes: string
	className?: string
}

export function IssueNotesCallout({ notes, className }: IssueNotesCalloutProps) {
	return (
		<Alert variant="warn" className={cn("rounded-md px-4", className)}>
			<Eyebrow as="div" className="mb-0.5 text-severity-warn">
				Notes
			</Eyebrow>
			<AlertDescription className="whitespace-pre-wrap text-foreground">{notes}</AlertDescription>
		</Alert>
	)
}

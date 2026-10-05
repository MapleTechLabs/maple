import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { SeverityBadge } from "@/components/errors/severity-badge"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

interface IssueLineProps {
	issue: ErrorIssueDocument
	/** Overrides the issue's total, e.g. occurrences on one release. */
	occurrences?: number
	occurrencesTitle?: string
	showService?: boolean
}

/** One linked issue row: severity, title, occurrence count, last seen. */
export function IssueLine({ issue, occurrences, occurrencesTitle, showService }: IssueLineProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const title = issue.errorLabel || issue.exceptionType || issue.exceptionMessage || "Unknown error"
	return (
		<Link
			to="/errors/issues/$issueId"
			params={{ issueId: issue.id }}
			className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<SeverityBadge severity={issue.severity} className="w-[60px] shrink-0 justify-center" />
			{showService ? (
				<span className="inline-flex shrink-0" title={issue.serviceName}>
					<ServiceDot serviceName={issue.serviceName} />
				</span>
			) : null}
			<span className="min-w-0 flex-1 truncate" title={title}>
				{title}
			</span>
			<span
				className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
				title={occurrencesTitle}
			>
				{formatNumber(occurrences ?? issue.occurrenceCount)}×
			</span>
			<span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
				{formatRelativeTimeOrDate(issue.lastSeenAt, undefined, effectiveTimezone)}
			</span>
		</Link>
	)
}

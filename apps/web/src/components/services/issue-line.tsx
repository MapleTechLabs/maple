import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { formatNumber } from "@maple/ui/lib/format"

import { SeverityBadge } from "@/components/errors/severity-badge"
import { RelativeTime } from "@/components/common/relative-time"
import { ListRow } from "@maple/ui/components/ui/list-row"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"

interface IssueLineProps {
	issue: ErrorIssueDocument
	/** Overrides the issue's total, e.g. occurrences on one release. */
	occurrences?: number
	occurrencesTitle?: string
	showService?: boolean
}

/** One linked issue row: severity, title, occurrence count, last seen. */
export function IssueLine({ issue, occurrences, occurrencesTitle, showService }: IssueLineProps) {
	const title = issue.errorLabel || issue.exceptionType || issue.exceptionMessage || "Unknown error"
	return (
		<ListRow
			density="compact"
			className="gap-2.5 rounded-sm px-2 text-sm"
			render={<Link to="/errors/issues/$issueId" params={{ issueId: issue.id }} />}
			leading={
				<>
					<SeverityBadge severity={issue.severity} className="w-[60px] justify-center" />
					{showService ? (
						<span className="ml-2.5 inline-flex" title={issue.serviceName}>
							<ServiceDot serviceName={issue.serviceName} />
						</span>
					) : null}
				</>
			}
			title={<TruncatedText text={title} className="font-normal" />}
			trailing={
				<>
					<span
						className="font-mono text-xs tabular-nums text-muted-foreground"
						title={occurrencesTitle}
					>
						{formatNumber(occurrences ?? issue.occurrenceCount)}×
					</span>
					<RelativeTime
						value={issue.lastSeenAt}
						variant="orDate"
						mono
						tooltip="title"
						className="w-14 text-right text-xs text-muted-foreground/70"
					/>
				</>
			}
		/>
	)
}

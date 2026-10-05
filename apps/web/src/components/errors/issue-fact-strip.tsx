import { FactLane, FactStrip } from "./fact-strip"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

/**
 * The issue's numbers, in named lanes, at the top of the page.
 *
 * These used to live in the rail as a "Activity" group of four right-aligned
 * rows, 288px away from the chart they describe, under a heading with exactly
 * the same typography as every section heading in the main column — so the two
 * read at the same rank and neither won. Worse, one of them was labelled
 * "Events (window)" on a page that had no window control at all.
 *
 * `regressionCount`, `lastRegressedAt`, `resolvedVersions` and `snoozeUntil`
 * were fetched on every load and drawn nowhere, which meant the page could not
 * answer the question the whole workflow exists for: did the fix hold.
 */
export function IssueFactStrip({
	issue,
	windowCount,
	windowLabel,
}: {
	issue: ErrorIssueDocument
	/** Occurrences inside the selected range, summed from the detail timeseries. */
	windowCount: number
	/** What the user picked, e.g. "12h" — so the lane names its own scope. */
	windowLabel: string
}) {
	return (
		<FactStrip>
			<FactLane label={`Events · ${windowLabel}`}>
				<Count value={windowCount} />
			</FactLane>
			<FactLane label="Events · all time">
				<Count value={issue.occurrenceCount} />
			</FactLane>
			<FactLane label="First seen">
				<Stamp iso={issue.firstSeenAt} />
			</FactLane>
			<FactLane label="Last seen">
				<Stamp iso={issue.lastSeenAt} />
			</FactLane>
			{issue.regressionCount > 0 ? (
				<FactLane label="Regressions">
					<span className="text-foreground">
						<span className="tabular-nums">{issue.regressionCount}</span>
						{issue.lastRegressedAt ? (
							<span className="text-muted-foreground">
								{" "}
								· last {formatRelativeTime(issue.lastRegressedAt)}
							</span>
						) : null}
					</span>
				</FactLane>
			) : issue.lastResolvedAt ? (
				// No regressions *and* a past resolution is the good outcome, and it is
				// worth stating — an empty lane would read as "never fixed".
				<FactLane label="Fix held since">
					<Stamp iso={issue.lastResolvedAt} />
				</FactLane>
			) : null}
			{issue.resolvedVersions.length > 0 ? (
				<FactLane label="Resolved in">
					<span
						className="block truncate font-mono text-xs text-foreground"
						title={issue.resolvedVersions.join(", ")}
					>
						{issue.resolvedVersions.join(", ")}
					</span>
				</FactLane>
			) : null}
			{issue.snoozeUntil ? (
				<FactLane label="Snoozed until">
					<Stamp iso={issue.snoozeUntil} />
				</FactLane>
			) : null}
		</FactStrip>
	)
}

function Count({ value }: { value: number }) {
	return (
		<span className="text-foreground tabular-nums" title={value.toLocaleString()}>
			{formatNumber(value)}
		</span>
	)
}

function Stamp({ iso }: { iso: string }) {
	const { effectiveTimezone } = useTimezonePreference()

	return (
		<span
			className="text-foreground tabular-nums"
			title={formatTimestampInTimezone(iso, { timeZone: effectiveTimezone, withYear: true })}
		>
			{formatRelativeTime(iso)}
		</span>
	)
}

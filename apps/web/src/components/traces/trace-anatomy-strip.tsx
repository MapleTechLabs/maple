import {
	TraceAnatomyStrip as SharedTraceAnatomyStrip,
	type TraceAnatomyStripProps,
} from "@maple/ui/components/traces/trace-anatomy-strip"
import { shortId } from "@maple/ui/lib/ids"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"
import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

/** Absolute start in the viewer's timezone (what you correlate against), with the age beside it. */
function TraceStartedAt({ startTime }: { startTime: string }) {
	const { effectiveTimezone } = useTimezonePreference()
	// Warehouse timestamps carry no zone and are UTC; Date.parse would read them as local.
	const epochMs = toEpochMs(startTime)
	if (Number.isNaN(epochMs)) return null
	return (
		<time dateTime={new Date(epochMs).toISOString()} className="tabular-nums">
			<span className="text-foreground">
				{formatTimestampInTimezone(epochMs, { timeZone: effectiveTimezone, withMilliseconds: true })}
			</span>{" "}
			· {formatRelativeTime(epochMs)}
		</time>
	)
}

/** The shared strip, with the root's commit SHA linked to the connected VCS provider. */
export function TraceAnatomyStrip({
	commitSha,
	startTime,
	...props
}: Omit<TraceAnatomyStripProps, "commit" | "startedAt"> & { commitSha?: string; startTime: string }) {
	return (
		<SharedTraceAnatomyStrip
			{...props}
			startedAt={<TraceStartedAt startTime={startTime} />}
			commit={
				commitSha ? (
					<CommitShaHoverCard
						sha={commitSha}
						copy={{ value: commitSha, label: "commit SHA" }}
						className="font-mono text-xs text-muted-foreground hover:text-foreground"
					>
						{shortId(commitSha, "sha")}
					</CommitShaHoverCard>
				) : undefined
			}
		/>
	)
}

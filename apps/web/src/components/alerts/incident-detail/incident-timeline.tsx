import { Link } from "@tanstack/react-router"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { TONE_BORDER } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import type { IncidentTimelineEntry } from "@/lib/alerts/incident-timeline"
import { formatDateInTimezone, formatTimeInTimezone } from "@/lib/timezone-format"

function sameDay(a: number, b: number, timeZone: string): boolean {
	return formatDateInTimezone(a, { timeZone }) === formatDateInTimezone(b, { timeZone })
}

export function IncidentTimeline({
	entries,
	timeZone,
	loading,
	failed,
}: {
	entries: ReadonlyArray<IncidentTimelineEntry>
	timeZone: string
	/** Delivery or investigation rows are still loading. */
	loading: boolean
	/** Delivery history failed to load, so the list is only partial. */
	failed: boolean
}) {
	const firstAt = entries[0]?.at ?? 0
	return (
		<section className="space-y-3">
			<Eyebrow as="h2">Timeline</Eyebrow>
			<ol className="divide-y divide-border/60 border-t border-border/60">
				{entries.map((entry) => (
					<li key={entry.key} className="grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] gap-x-3 py-3">
						<time
							dateTime={new Date(entry.at).toISOString()}
							className="pt-px font-mono text-muted-foreground text-xs tabular-nums"
						>
							{sameDay(entry.at, firstAt, timeZone)
								? formatTimeInTimezone(entry.at, { timeZone })
								: `${formatDateInTimezone(entry.at, { timeZone })} ${formatTimeInTimezone(entry.at, { timeZone })}`}
						</time>
						<span className="flex justify-center pt-1.5">
							{entry.pending ? (
								<span
									aria-hidden
									className={cn("size-2 rounded-full border", TONE_BORDER[entry.tone])}
								/>
							) : (
								<StatusDot tone={entry.tone} size="lg" />
							)}
						</span>
						<div className="min-w-0 space-y-0.5">
							<p className={cn("text-sm", entry.pending && "text-muted-foreground")}>
								{entry.title}
							</p>
							{entry.detail ? (
								<p className="text-muted-foreground text-xs">{entry.detail}</p>
							) : null}
							{entry.investigation ? (
								<div className="mt-2 space-y-2 rounded-md border bg-muted/30 px-3 py-2.5">
									{entry.investigation.headline ? (
										<p className="text-sm leading-relaxed">
											{entry.investigation.headline}
										</p>
									) : null}
									<Link
										to="/investigations/$id"
										params={{ id: entry.investigation.id }}
										className="text-primary text-xs hover:underline"
									>
										Open investigation
									</Link>
								</div>
							) : null}
						</div>
					</li>
				))}
				{loading ? (
					<li className="py-3">
						<Skeleton className="h-4 w-2/3" />
					</li>
				) : null}
			</ol>
			{failed ? (
				<p className="text-muted-foreground text-xs">
					Delivery history could not be loaded, so notifications are missing.
				</p>
			) : null}
		</section>
	)
}

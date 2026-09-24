import { useMemo } from "react"

import type { AlertIncidentDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { useTimezonePreference } from "@/hooks/use-timezone-preference"

/**
 * Fixed-bucket strip of a rule's incident history over a time range: red where
 * an incident was firing (bright while still open), green otherwise. Used at
 * two sizes — the rule detail sticky header (default) and a compact per-row
 * variant on the alerts overview.
 */
export function IncidentTimelineStrip({
	incidents,
	range,
	buckets = 45,
	compact = false,
	showAxisLabels = true,
	className,
}: {
	incidents: ReadonlyArray<AlertIncidentDocument>
	/** Epoch-ms window the strip frames. */
	range: { min: number; max: number }
	buckets?: number
	/** Row-sized variant: shorter cells, no labels. */
	compact?: boolean
	showAxisLabels?: boolean
	className?: string
}) {
	const { effectiveTimezone } = useTimezonePreference()

	const segments = useMemo(
		() =>
			incidents.map((incident) => ({
				status: incident.status,
				start: new Date(incident.firstTriggeredAt).getTime(),
				end: incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : range.max,
				// From here on the open incident is waiting on telemetry rather than
				// observed breaching. Kept on the segment so a bucket is hatched only
				// when EVERY open incident in it is held — a sibling group still
				// firing keeps the bucket red.
				heldSince:
					incident.status === "open" && incident.heldSince
						? new Date(incident.heldSince).getTime()
						: null,
			})),
		[incidents, range.max],
	)

	const totalRange = Math.max(1, range.max - range.min)

	return (
		<div className={cn("space-y-1", className)}>
			<div className={cn("flex items-center", compact ? "gap-px" : "gap-[3px]")}>
				{Array.from({ length: buckets }, (_, i) => {
					const bucketStart = range.min + (i / buckets) * totalRange
					const bucketEnd = range.min + ((i + 1) / buckets) * totalRange
					const hits = segments.filter((seg) => seg.end > bucketStart && seg.start < bucketEnd)
					const open = hits.filter((seg) => seg.status === "open")
					const hit = open[0] ?? hits[0]
					const held =
						open.length > 0 &&
						open.every((seg) => seg.heldSince !== null && seg.heldSince < bucketEnd)
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional strip
							key={i}
							className={cn(
								"flex-1 rounded-[2px]",
								compact ? "h-2" : "h-3",
								hit
									? held
										? "bg-[repeating-linear-gradient(135deg,var(--destructive)_0_2px,transparent_2px_5px)] bg-warning/30"
										: hit.status === "open"
											? "bg-destructive"
											: "bg-destructive/50"
									: "bg-chart-apdex/60",
							)}
						/>
					)
				})}
			</div>
			{showAxisLabels && !compact && (
				<div className="flex justify-between font-mono text-[11px] text-muted-foreground">
					<span>{formatEdge(range.min, effectiveTimezone)}</span>
					<span>{formatEdge(range.max, effectiveTimezone)}</span>
				</div>
			)}
		</div>
	)
}

function formatEdge(ms: number, timeZone: string): string {
	return new Date(ms).toLocaleString(undefined, {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

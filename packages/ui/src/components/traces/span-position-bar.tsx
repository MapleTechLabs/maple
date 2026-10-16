import { formatDuration } from "../../lib/format"
import type { SpanNode } from "../../lib/types"

/**
 * Where this span sits inside the whole trace: a muted track spanning the
 * trace's wall-clock time, with the span's own window in its service color.
 * Offsets are clamped so clock-skewed spans never paint outside the track.
 */
export function SpanPositionBar({
	span,
	traceStartTime,
	totalDurationMs,
	color,
}: {
	span: SpanNode
	traceStartTime: string
	totalDurationMs: number
	color: string
}) {
	const offsetMs = new Date(span.startTime).getTime() - new Date(traceStartTime).getTime()
	if (!Number.isFinite(offsetMs) || totalDurationMs <= 0) return null

	const offsetPct = Math.min(Math.max((offsetMs / totalDurationMs) * 100, 0), 100)
	const widthPct = Math.min(Math.max((span.durationMs / totalDurationMs) * 100, 0.75), 100 - offsetPct)

	return (
		<div className="py-1">
			<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className="absolute inset-y-0 rounded-full"
					style={{ left: `${offsetPct}%`, width: `${widthPct}%`, backgroundColor: color }}
				/>
			</div>
			<div className="mt-1 flex justify-between text-3xs text-muted-foreground tabular-nums">
				{offsetMs < 0 ? (
					<span
						className="text-severity-warn"
						title="Starts before the trace root: the clocks disagree"
					>
						{"\u2212"}
						{formatDuration(Math.abs(offsetMs))} (clock skew)
					</span>
				) : (
					<span>+{formatDuration(offsetMs)}</span>
				)}
				<span>{formatDuration(totalDurationMs)} total</span>
			</div>
		</div>
	)
}

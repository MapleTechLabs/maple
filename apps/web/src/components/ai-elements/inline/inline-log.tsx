import { Link } from "@tanstack/react-router"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { INLINE_CARD_ROW, inlineCardClass } from "./inline-card"
import type { InlineLogData } from "./types"

/**
 * One log line. The card is not itself a link — the trace link inside it is the
 * only destination a log has — so the row stays a `div` and the affordance sits on
 * the one element that navigates.
 */
export function InlineLog({ data }: { data: InlineLogData }) {
	return (
		<div className={inlineCardClass()}>
			<div className={INLINE_CARD_ROW}>
				<SeverityBadge severity={data.severity} className="shrink-0" />
				{data.serviceName && (
					<span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
						{data.serviceName}
					</span>
				)}
				<span className="min-w-0 flex-1 truncate text-xs text-foreground" title={data.body}>
					{data.body}
				</span>
				{data.timestamp && (
					<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
						{new Date(normalizeTimestampInput(data.timestamp)).toLocaleTimeString()}
					</span>
				)}
				{data.traceId && (
					<Link
						to="/traces/$traceId"
						params={{ traceId: data.traceId }}
						search={data.timestamp ? { t: data.timestamp } : undefined}
						target="_blank"
						rel="noreferrer"
						className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						title={data.traceId}
					>
						trace
					</Link>
				)}
			</div>
		</div>
	)
}

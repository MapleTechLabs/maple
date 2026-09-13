import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { PulseIcon } from "@/components/icons"
import {
	INLINE_CARD_META,
	INLINE_CARD_ROW,
	InlineCardChevron,
	InlineMetric,
	InlineServiceChips,
	inlineCardClass,
} from "./inline-card"
import type { InlineTraceData } from "./types"

export function InlineTrace({ data }: { data: InlineTraceData }) {
	const services = data.services ?? []
	return (
		<Link
			to="/traces/$traceId"
			params={{ traceId: data.id }}
			target="_blank"
			rel="noreferrer"
			className={cn("group/inline", inlineCardClass(true))}
		>
			<div className={INLINE_CARD_ROW}>
				<PulseIcon
					className={cn(
						"size-3.5 shrink-0",
						data.hasError ? "text-severity-error" : "text-muted-foreground",
					)}
				/>
				<span
					className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
					title={data.name}
				>
					{data.name}
				</span>
				{data.spanCount != null && (
					<InlineMetric
						width="min-w-12"
						unit="spans"
						tone="text-muted-foreground"
						className="hidden @[26rem]/inline:inline"
					>
						{data.spanCount}
					</InlineMetric>
				)}
				<InlineMetric width="min-w-14">
					<LatencyValue ms={data.durationMs} scale="p99" />
				</InlineMetric>
				<InlineCardChevron />
			</div>
			<div className={INLINE_CARD_META}>
				{/* The id is evidence rather than a label — it is what a follow-up question
				    names — so it sits under the span name instead of competing with it. */}
				<span className="shrink-0 font-mono text-[11px] text-muted-foreground/70" title={data.id}>
					{data.id.slice(0, 12)}
				</span>
				<InlineServiceChips services={services} />
			</div>
		</Link>
	)
}

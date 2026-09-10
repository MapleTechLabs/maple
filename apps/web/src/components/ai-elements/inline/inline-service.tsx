import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServerIcon } from "@/components/icons"
import { INLINE_CARD_ROW, InlineCardChevron, InlineMetric, inlineCardClass } from "./inline-card"
import type { InlineServiceData } from "./types"

/** Same thresholds the services list tones by: under 1% is noise, 5% is an outage. */
function errorTone(rate: number): string {
	if (rate >= 5) return "text-severity-error"
	if (rate >= 1) return "text-severity-warn"
	return "text-muted-foreground"
}

export function InlineService({ data }: { data: InlineServiceData }) {
	return (
		<Link
			to="/services/$serviceName"
			params={{ serviceName: data.name }}
			target="_blank"
			rel="noreferrer"
			className={cn("group/inline", inlineCardClass(true))}
		>
			<div className={INLINE_CARD_ROW}>
				<ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span
					className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
					title={data.name}
				>
					{data.name}
				</span>
				{/* The card is its own container: in a 420px side panel the service name matters
				    more than its throughput, so the least diagnostic lane goes first. */}
				{data.throughput != null && (
					<InlineMetric
						width="min-w-20"
						unit="req/s"
						tone="text-muted-foreground"
						className="hidden @[26rem]/inline:inline"
					>
						{formatNumber(data.throughput)}
					</InlineMetric>
				)}
				{data.errorRate != null && (
					<InlineMetric width="min-w-14" unit="err" tone={errorTone(data.errorRate)}>
						{formatErrorRate(data.errorRate / 100)}
					</InlineMetric>
				)}
				{data.p99Ms != null && (
					<InlineMetric width="min-w-16" unit="p99">
						<LatencyValue ms={data.p99Ms} scale="p99" />
					</InlineMetric>
				)}
				<InlineCardChevron />
			</div>
		</Link>
	)
}

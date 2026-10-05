import { Link } from "@tanstack/react-router"
import type { InlineServiceData } from "@maple/domain/chat-annotations"
import { cn } from "@maple/ui/lib/utils"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServerIcon } from "@/components/icons"
import { INLINE_CARD_ROW, InlineCardChevron, InlineMetric, inlineCardClass } from "./inline-card"

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
				<TruncatedText className="flex-1 text-xs font-medium text-foreground">{data.name}</TruncatedText>
				{/* The card is its own container: in a 420px side panel the service name matters
				    more than its throughput, so the least diagnostic lane goes first. */}
				{data.throughputRpm != null && (
					<InlineMetric
						width="min-w-20"
						unit="rpm"
						tone="text-muted-foreground"
						className="hidden @[26rem]/inline:inline"
					>
						{formatNumber(data.throughputRpm)}
					</InlineMetric>
				)}
				{data.errorRate != null && (
					<InlineMetric width="min-w-14" unit="err" tone={errorRateClass(data.errorRate / 100)}>
						{formatErrorRate(data.errorRate / 100)}
					</InlineMetric>
				)}
				{/* p99 wins when both arrive, but the label always names the value shown —
				    a p95 published under a p99 header is a wrong number, not a rounding. */}
				{data.p99Ms != null ? (
					<InlineMetric width="min-w-16" unit="p99">
						<LatencyValue ms={data.p99Ms} scale="p99" />
					</InlineMetric>
				) : data.p95Ms != null ? (
					<InlineMetric width="min-w-16" unit="p95">
						<LatencyValue ms={data.p95Ms} scale="p95" />
					</InlineMetric>
				) : null}
				<InlineCardChevron />
			</div>
		</Link>
	)
}

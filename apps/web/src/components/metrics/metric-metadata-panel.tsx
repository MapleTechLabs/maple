import { ErrorState } from "@/components/common/error-state"
import { Panel } from "@maple/ui/components/ui/panel"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { MetricTypeBadge } from "./metric-type-badge"
import type { MetricCatalogSummary } from "./metric-detail"
import { getMetricAttributeKeysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

interface MetricMetadataPanelProps {
	summary: MetricCatalogSummary
	startTime: string
	endTime: string
}

export function MetricMetadataPanel({ summary, startTime, endTime }: MetricMetadataPanelProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const keysResult = useAtomValue(
		getMetricAttributeKeysResultAtom({
			data: {
				startTime,
				endTime,
				metricName: summary.metricName,
				metricType: summary.metricType,
			},
		}),
	)

	return (
		<Panel className="gap-4 p-3">
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<MetricTypeBadge type={summary.metricType} />
					{summary.unit && (
						<Badge variant="outline" size="xs" mono>
							{summary.unit}
						</Badge>
					)}
					{summary.metricType === "sum" && (
						<Badge variant="outline" size="xs">
							{summary.isMonotonic ? "monotonic" : "non-monotonic"}
						</Badge>
					)}
				</div>
				{summary.description && (
					<p className="text-xs text-muted-foreground">{summary.description}</p>
				)}
			</div>

			<KeyValueList className="gap-2">
				<KeyValue label="Datapoints in range" mono>
					{formatNumber(summary.dataPointCount)}
				</KeyValue>
				<KeyValue label="First seen" mono>
					{formatTimestampInTimezone(summary.firstSeen, {
						timeZone: effectiveTimezone,
						withYear: true,
					})}
				</KeyValue>
				<KeyValue label="Last seen" mono>
					{formatTimestampInTimezone(summary.lastSeen, {
						timeZone: effectiveTimezone,
						withYear: true,
					})}
				</KeyValue>
			</KeyValueList>

			{summary.services.length > 0 && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						Emitted by {countLabel(summary.services.length, "service")}
					</p>
					<div className="flex flex-wrap gap-1.5">
						{summary.services.map((service) => (
							<Badge
								key={service}
								variant="outline"
								size="xs"
								mono
								className="max-w-full"
								title={service}
							>
								<span className="min-w-0 truncate">{service}</span>
							</Badge>
						))}
					</div>
				</div>
			)}

			<div className="space-y-1.5">
				<p className="text-xs text-muted-foreground">Attributes</p>
				{Result.builder(keysResult)
					.onInitial(() => <Skeleton className="h-12 w-full" />)
					.onError((error) => (
						<ErrorState
							error={error}
							title="Failed to load attribute keys"
							variant="inline"
							className="py-1"
						/>
					))
					.onSuccess((response) =>
						response.data.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								This metric has no datapoint attributes.
							</p>
						) : (
							<ul className="space-y-1">
								{response.data.map((row) => (
									<li
										key={row.attributeKey}
										className="flex items-center justify-between gap-2 text-xs"
									>
										<span className="truncate font-mono">{row.attributeKey}</span>
										<span className="shrink-0 font-mono text-muted-foreground">
											{formatNumber(row.usageCount)}
										</span>
									</li>
								))}
							</ul>
						),
					)
					.render()}
			</div>
		</Panel>
	)
}

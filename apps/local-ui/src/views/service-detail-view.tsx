import { useMemo } from "react"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatDuration, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	useLocalServiceOperations,
	useLocalServiceOperationsTimeseries,
	useLocalServiceOverview,
} from "../hooks/use-local-service-detail"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor } from "../lib/router"
import { chartWindow, WIDEST_RANGE } from "../lib/time"
import { LinkRow, RowLink } from "../components/row-link"
import { SeriesChart } from "../components/series-chart"
import { RefreshButton, TimeRangeSelect } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"

const CHART_SERIES_LIMIT = 8

interface ServiceDetailViewProps {
	serviceName: string
	backLabel: string
	onBack: () => void
}

/**
 * Drill-down to traces touching this service. Span scope: most services never
 * own a trace's root span, so a root-scoped search would come back empty.
 */
function tracesHref(serviceName: string, range: string, spanName?: string): string {
	const params = new URLSearchParams({ scope: "spans", service: serviceName, range })
	if (spanName) params.set("span", spanName)
	return hrefFor("/traces", params)
}

export function ServiceDetailView({ serviceName, backLabel, onBack }: ServiceDetailViewProps) {
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const { bounds } = timeWindow

	const overview = useLocalServiceOverview(serviceName, bounds)
	const operations = useLocalServiceOperations(serviceName, bounds)
	const topSpanNames = useMemo(
		() => (operations.data ?? []).slice(0, CHART_SERIES_LIMIT).map((op) => op.spanName),
		[operations.data],
	)
	const firstSeenMs = overview.data?.firstSeenMs ?? null
	const chart = useMemo(() => chartWindow(bounds, firstSeenMs), [bounds, firstSeenMs])
	const timeseries = useLocalServiceOperationsTimeseries(serviceName, topSpanNames, bounds, chart)

	const stats = overview.data?.stats

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					{backLabel}
				</Button>
				<span className="flex min-w-0 items-center gap-2">
					<ServiceDot serviceName={serviceName} />
					<span className="truncate text-sm font-medium">{serviceName}</span>
				</span>
				{stats?.deploymentEnvironments.map((environment) => (
					<Badge key={environment} variant="outline" className="px-1.5 py-0 text-[10px]">
						{environment}
					</Badge>
				))}
				<div className="ml-auto flex items-center gap-2">
					<Button variant="outline" size="sm" render={<a href={tracesHref(serviceName, range)} />}>
						View traces
					</Button>
					<RefreshButton advance={timeWindow.advance} since={overview.dataUpdatedAt} />
					<TimeRangeSelect value={range} onChange={setRange} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{overview.isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : overview.isError ? (
					<ErrorState label="service" error={overview.error} onRetry={() => overview.refetch()} />
				) : !stats ? (
					<div className="flex h-full flex-col items-center justify-center gap-3">
						<EmptyState
							title="No spans from this service in this range"
							hint="Widen the time range, or send some traffic to this service."
						/>
						{range !== WIDEST_RANGE ? (
							<Button variant="outline" size="sm" onClick={() => setRange(WIDEST_RANGE)}>
								Widen to 30 days
							</Button>
						) : null}
					</div>
				) : (
					<div className="space-y-6 p-4">
						<section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
							<StatCard label="Spans" value={formatNumber(stats.spanCount)} />
							<StatCard
								label="Errors"
								value={formatNumber(stats.errorCount)}
								danger={stats.errorCount > 0}
							/>
							<StatCard
								label="Error rate"
								value={formatErrorRate(stats.errorRate)}
								danger={stats.errorRate > 0.05}
							/>
							<StatCard
								label="p50"
								value={formatDuration(stats.p50LatencyMs)}
								valueClassName={latencyToneClass(stats.p50LatencyMs, "p50")}
							/>
							<StatCard
								label="p95"
								value={formatDuration(stats.p95LatencyMs)}
								valueClassName={latencyToneClass(stats.p95LatencyMs, "p95")}
							/>
							<StatCard
								label="p99"
								value={formatDuration(stats.p99LatencyMs)}
								valueClassName={latencyToneClass(stats.p99LatencyMs, "p99")}
							/>
						</section>

						<section className="space-y-2">
							<h3 className="text-sm font-medium">Throughput by operation</h3>
							<SeriesChart
								points={timeseries.data}
								window={chart}
								fill="zero"
								isPending={timeseries.isPending && topSpanNames.length > 0}
							/>
						</section>

						<section className="space-y-2">
							<h3 className="text-sm font-medium">Top operations</h3>
							{operations.isPending ? (
								<div className="flex h-24 items-center justify-center rounded-md border">
									<Spinner />
								</div>
							) : operations.isError ? (
								<ErrorState
									label="operations"
									error={operations.error}
									onRetry={() => operations.refetch()}
								/>
							) : (operations.data ?? []).length === 0 ? (
								<div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
									No operations recorded in this range.
								</div>
							) : (
								<div className="rounded-md border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Operation</TableHead>
												<TableHead className="text-right">Spans</TableHead>
												<TableHead className="text-right">Errors</TableHead>
												<TableHead className="text-right">Error rate</TableHead>
												<TableHead className="text-right">Avg</TableHead>
												<TableHead className="text-right">p50</TableHead>
												<TableHead className="text-right">p95</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{(operations.data ?? []).map((op) => (
												<LinkRow key={op.spanName}>
													<TableCell className="max-w-96 truncate font-mono text-xs">
														<RowLink
															href={tracesHref(serviceName, range, op.spanName)}
															label={`Traces with ${op.spanName}`}
														>
															{op.spanName}
														</RowLink>
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatNumber(op.estimatedSpanCount || op.spanCount)}
													</TableCell>
													<TableCell
														className={cn(
															"text-right tabular-nums",
															op.errorCount > 0 && "text-destructive",
														)}
													>
														{formatNumber(
															op.estimatedErrorCount || op.errorCount,
														)}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatErrorRate(op.errorRate)}
													</TableCell>
													<TableCell className="text-right">
														<LatencyValue ms={op.avgDurationMs} scale="avg" />
													</TableCell>
													<TableCell className="text-right">
														<LatencyValue ms={op.p50DurationMs} scale="p50" />
													</TableCell>
													<TableCell className="text-right">
														<LatencyValue ms={op.p95DurationMs} scale="p95" />
													</TableCell>
												</LinkRow>
											))}
										</TableBody>
									</Table>
								</div>
							)}
						</section>
					</div>
				)}
			</div>
		</div>
	)
}

function StatCard({
	label,
	value,
	danger,
	valueClassName,
}: {
	label: string
	value: string
	danger?: boolean
	/** Applied after `danger`, so it wins: carries the latency magnitude ramp. */
	valueClassName?: string
}) {
	return (
		<div className="rounded-md border bg-card px-3 py-2">
			<div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div
				className={cn(
					"text-lg font-semibold tabular-nums",
					danger && "text-destructive",
					valueClassName,
				)}
			>
				{value}
			</div>
		</div>
	)
}

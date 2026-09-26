import { useMemo } from "react"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { MetricTypeBadge } from "@maple/ui/components/metrics/metric-type-badge"
import { formatNumber, formatValueByUnit } from "@maple/ui/lib/format"
import {
	useLocalMetricBreakdown,
	useLocalMetricEntry,
	useLocalMetricTimeseries,
} from "../hooks/use-local-metric-detail"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { chartWindow, formatRelativeTime, parseClickHouseDateTime, WIDEST_RANGE } from "../lib/time"
import { chartUnitFromOtel, humanizeUnit, isCounter } from "../lib/units"
import { SeriesChart } from "../components/series-chart"
import { RefreshButton, TimeRangeSelect } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"

interface MetricDetailViewProps {
	metricName: string
	backLabel: string
	onBack: () => void
}

export function MetricDetailView({ metricName, backLabel, onBack }: MetricDetailViewProps) {
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const { bounds } = timeWindow

	const entryQuery = useLocalMetricEntry(metricName, bounds)
	const entry = entryQuery.data
	const firstSeenMs = parseClickHouseDateTime(entry?.firstSeen)
	const chart = useMemo(() => chartWindow(bounds, firstSeenMs), [bounds, firstSeenMs])
	const timeseries = useLocalMetricTimeseries(entry, bounds, chart)
	const breakdown = useLocalMetricBreakdown(entry, bounds)

	const counter = entry ? isCounter(entry) : false
	const unitLabel = entry ? humanizeUnit(entry.metricUnit, entry.metricName) : ""
	const chartUnit = entry && !counter ? chartUnitFromOtel(entry.metricUnit, entry.metricName) : undefined
	// A total of cumulative counter readings means nothing; histograms' sums do.
	const showSum = entry?.metricType === "histogram" || entry?.metricType === "exponential_histogram"

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					{backLabel}
				</Button>
				<span className="min-w-0 truncate font-mono text-xs" title={metricName}>
					{metricName}
				</span>
				{entry ? <MetricTypeBadge type={entry.metricType} /> : null}
				{unitLabel ? (
					<Badge
						variant="outline"
						className="px-1 py-0 font-mono text-[10px]"
						title={entry?.metricUnit}
					>
						{unitLabel}
					</Badge>
				) : null}
				<div className="ml-auto flex items-center gap-2">
					<RefreshButton advance={timeWindow.advance} since={entryQuery.dataUpdatedAt} />
					<TimeRangeSelect value={range} onChange={setRange} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{entryQuery.isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : entryQuery.isError ? (
					<ErrorState
						label="metric"
						error={entryQuery.error}
						onRetry={() => entryQuery.refetch()}
					/>
				) : !entry ? (
					<div className="flex h-full flex-col items-center justify-center gap-3">
						<EmptyState
							title="Metric not found"
							hint="Nothing reported this metric in the selected time range."
						/>
						{range !== WIDEST_RANGE ? (
							<Button variant="outline" size="sm" onClick={() => setRange(WIDEST_RANGE)}>
								Widen to 30 days
							</Button>
						) : null}
					</div>
				) : (
					<div className="space-y-6 p-4">
						{entry.metricDescription ? (
							<p className="text-sm text-muted-foreground">{entry.metricDescription}</p>
						) : null}

						<section className="space-y-2">
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<h3 className="text-sm font-medium">
									{counter
										? `Rate (${unitLabel ? `${unitLabel} ` : ""}per second)`
										: `Average value${unitLabel ? ` (${unitLabel})` : ""}`}{" "}
									by service
								</h3>
								<span className="text-xs text-muted-foreground">
									{entry.serviceNames.length.toLocaleString()} services ·{" "}
									{formatNumber(entry.dataPointCount)} datapoints · last seen{" "}
									{formatRelativeTime(entry.lastSeen)}
								</span>
							</div>
							{timeseries.isError ? (
								<ErrorState
									label="timeseries"
									error={timeseries.error}
									onRetry={() => timeseries.refetch()}
								/>
							) : (
								<SeriesChart
									points={timeseries.data}
									window={chart}
									fill={counter ? "zero" : "sparse"}
									isPending={timeseries.isPending}
									heightClassName="h-64"
									unit={chartUnit}
									fitYAxisToData={!counter}
								/>
							)}
						</section>

						<section className="space-y-2">
							<h3 className="text-sm font-medium">Breakdown by service</h3>
							{breakdown.isPending ? (
								<div className="flex h-24 items-center justify-center rounded-md border">
									<Spinner />
								</div>
							) : breakdown.isError ? (
								<ErrorState
									label="breakdown"
									error={breakdown.error}
									onRetry={() => breakdown.refetch()}
								/>
							) : (
								<div className="rounded-md border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Service</TableHead>
												<TableHead className="text-right">
													{counter ? "Avg reading" : "Avg"}
												</TableHead>
												{showSum ? (
													<TableHead className="text-right">Sum</TableHead>
												) : null}
												<TableHead className="text-right">Datapoints</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{(breakdown.data ?? []).map((row) => (
												<TableRow key={row.name}>
													<TableCell className="font-mono text-xs">
														{row.name || "-"}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatValueByUnit(row.avgValue, chartUnit)}
													</TableCell>
													{showSum ? (
														<TableCell className="text-right tabular-nums">
															{formatValueByUnit(row.sumValue, chartUnit)}
														</TableCell>
													) : null}
													<TableCell className="text-right tabular-nums">
														{row.count.toLocaleString()}
													</TableCell>
												</TableRow>
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

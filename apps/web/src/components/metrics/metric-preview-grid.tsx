import * as React from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { SignalEmptyState } from "@/components/common/signal-empty-state"
import { ErrorState } from "@/components/common/error-state"
import { MetricPreviewCard, type MetricPreviewEntry } from "./metric-preview-card"
import type { ListMetricsInput, Metric, MetricSparklinePoint } from "@/api/warehouse/metrics"
import {
	getMetricSparklinesResultAtom,
	listMetricsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"

const PAGE_SIZE = 24
/** Catalog rows fetched once; unique metrics are paginated client-side. */
const CATALOG_LIMIT = 500

const METRIC_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const
type SparklineMetricType = (typeof METRIC_TYPES)[number]

interface MetricPreviewGridProps {
	search: string
	metricType: ListMetricsInput["metricType"] | null
	startTime: string
	endTime: string
	onOpenMetric: (metric: Metric) => void
	onClearFilters: () => void
}

/** Collapses per-(metric, service) catalog rows into one grid entry per metric. */
function toEntries(rows: Metric[]): Array<MetricPreviewEntry & { firstRow: Metric }> {
	const byMetric = new Map<string, MetricPreviewEntry & { firstRow: Metric }>()
	for (const row of rows) {
		const key = `${row.metricName}::${row.metricType}`
		const existing = byMetric.get(key)
		if (existing) {
			if (row.serviceName && !existing.serviceNames.includes(row.serviceName)) {
				existing.serviceNames.push(row.serviceName)
			}
			continue
		}
		byMetric.set(key, {
			metricName: row.metricName,
			metricType: row.metricType,
			metricUnit: row.metricUnit,
			metricDescription: row.metricDescription,
			serviceNames: row.serviceName ? [row.serviceName] : [],
			firstRow: row,
		})
	}
	return [...byMetric.values()]
}

export function MetricPreviewGrid({
	search,
	metricType,
	startTime,
	endTime,
	onOpenMetric,
	onClearFilters,
}: MetricPreviewGridProps) {
	const [visiblePages, setVisiblePages] = React.useState(1)

	const catalogResult = useAtomValue(
		listMetricsResultAtom({
			data: {
				search: search || undefined,
				metricType: metricType || undefined,
				limit: CATALOG_LIMIT,
				startTime,
				endTime,
			},
		}),
	)

	return Result.builder(catalogResult)
		.onInitial(() => (
			<SkeletonList
				rows={8}
				rowClassName="h-32"
				className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
			/>
		))
		.onError((error) => <ErrorState error={error} />)
		.onSuccess((response) => {
			const entries = toEntries(response.data)

			if (entries.length === 0) {
				return (
					<SignalEmptyState
						signal="metrics"
						filtered={search !== "" || Boolean(metricType)}
						onClearFilters={onClearFilters}
					/>
				)
			}

			const pages: Array<typeof entries> = []
			for (let i = 0; i < Math.min(visiblePages * PAGE_SIZE, entries.length); i += PAGE_SIZE) {
				pages.push(entries.slice(i, i + PAGE_SIZE))
			}
			const hasMore = entries.length > visiblePages * PAGE_SIZE

			return (
				<div className="space-y-3">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{pages.map((page, index) => (
							<GridPage
								key={index}
								entries={page}
								startTime={startTime}
								endTime={endTime}
								onOpenMetric={onOpenMetric}
							/>
						))}
					</div>

					<ListFooter
						shown={Math.min(visiblePages * PAGE_SIZE, entries.length)}
						total={entries.length}
						noun="metrics"
						hasMore={hasMore}
						onLoadMore={() => setVisiblePages((current) => current + 1)}
						align="start"
						className="justify-start p-0 text-sm"
					/>
				</div>
			)
		})
		.render()
}

/**
 * One page of cards with its own batched sparkline fetch — at most one query
 * per metric type per page (≤4), never one per card. Earlier pages keep their
 * already-cached atoms when a new page mounts.
 */
function GridPage({
	entries,
	startTime,
	endTime,
	onOpenMetric,
}: {
	entries: Array<MetricPreviewEntry & { firstRow: Metric }>
	startTime: string
	endTime: string
	onOpenMetric: (metric: Metric) => void
}) {
	const { pointsByMetric, loading } = usePageSparklines(entries, startTime, endTime)

	return (
		<>
			{entries.map((entry) => (
				<MetricPreviewCard
					key={`${entry.metricName}::${entry.metricType}`}
					entry={entry}
					points={pointsByMetric.get(`${entry.metricName}::${entry.metricType}`)}
					loading={loading}
					onOpen={() => onOpenMetric(entry.firstRow)}
				/>
			))}
		</>
	)
}

function namesOfType(entries: ReadonlyArray<MetricPreviewEntry>, metricType: SparklineMetricType): string[] {
	return entries.filter((entry) => entry.metricType === metricType).map((entry) => entry.metricName)
}

type SparklinesResponse = { data: Array<{ metricName: string; points: MetricSparklinePoint[] }> }

function useTypeSparklines(
	metricType: SparklineMetricType,
	names: string[],
	startTime: string,
	endTime: string,
) {
	return useAtomValue(
		names.length > 0
			? getMetricSparklinesResultAtom({
					data: { metricType, metricNames: names, startTime, endTime },
				})
			: disabledResultAtom<SparklinesResponse>(),
	)
}

function usePageSparklines(entries: ReadonlyArray<MetricPreviewEntry>, startTime: string, endTime: string) {
	// One hook call per metric type — a fixed set, so hook order is stable.
	const sumResult = useTypeSparklines("sum", namesOfType(entries, "sum"), startTime, endTime)
	const gaugeResult = useTypeSparklines("gauge", namesOfType(entries, "gauge"), startTime, endTime)
	const histogramResult = useTypeSparklines(
		"histogram",
		namesOfType(entries, "histogram"),
		startTime,
		endTime,
	)
	const expHistogramResult = useTypeSparklines(
		"exponential_histogram",
		namesOfType(entries, "exponential_histogram"),
		startTime,
		endTime,
	)

	const results: Array<[SparklineMetricType, typeof sumResult]> = [
		["sum", sumResult],
		["gauge", gaugeResult],
		["histogram", histogramResult],
		["exponential_histogram", expHistogramResult],
	]

	const pointsByMetric = new Map<string, MetricSparklinePoint[]>()
	let loading = false
	for (const [metricType, result] of results) {
		if (namesOfType(entries, metricType).length === 0) continue
		if (!Result.isSuccess(result) && !Result.isFailure(result)) loading = true
		if (Result.isSuccess(result)) {
			for (const series of result.value.data) {
				pointsByMetric.set(`${series.metricName}::${metricType}`, series.points)
			}
		}
	}

	return { pointsByMetric, loading }
}

import { useCallback, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@maple/ui/components/ui/badge"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { METRIC_TYPE_COLORS, MetricTypeBadge } from "@maple/ui/components/metrics/metric-type-badge"
import { cn } from "@maple/ui/lib/utils"
import {
	FilterSection,
	SearchableFilterSection,
	type FilterOption,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import {
	previewValues,
	sparklineWindow,
	useLocalMetricsList,
	useLocalMetricsSparklines,
	useLocalMetricsSummary,
	type MetricEntry,
	type SparklinePoint,
} from "../hooks/use-local-metrics"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor, useQueryParams } from "../lib/router"
import { WIDEST_RANGE } from "../lib/time"
import { humanizeUnit, isCounter } from "../lib/units"
import { PageShell } from "../components/page-shell"
import { SignalEmptyState } from "../components/signal-empty-state"
import {
	RefreshButton,
	TimeRangeSelect,
	Toolbar,
	ToolbarSearch,
	ToolbarStat,
	ToolbarStats,
} from "../components/toolbar"
import { ErrorState, ListSkeleton } from "../components/view-states"

/** Card height + the grid gap, for the virtualizer's row estimate. */
const CARD_ROW_HEIGHT = 124 + 12

export function MetricsListView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const service = query.get("service") || undefined
	const type = query.get("type") || undefined
	const search = query.get("q") || undefined

	const list = useLocalMetricsList({ service, type, search }, timeWindow.bounds)
	const summary = useLocalMetricsSummary(service, timeWindow.bounds)
	const { entries } = list
	// Sparklines cover every listed metric, not the service-filtered subset, so
	// a service click only re-filters and never re-runs their SQL.
	const allEntries = list.allEntries
	const chart = useMemo(
		() => sparklineWindow(allEntries, timeWindow.bounds),
		[allEntries, timeWindow.bounds],
	)
	const sparklines = useLocalMetricsSparklines(allEntries, timeWindow.bounds, chart)

	const totalDataPoints = (summary.data ?? []).reduce((sum, row) => sum + row.dataPointCount, 0)
	const typeFacets: FilterOption[] = (summary.data ?? [])
		.map((row) => ({ name: row.metricType, count: row.metricCount }))
		.sort((a, b) => b.count - a.count)

	const activeFilterCount = [service, type].filter(Boolean).length

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={list.query.isFetching}>
			<FilterSidebarHeader
				canClear={activeFilterCount > 0}
				onClear={() => setParams({ service: null, type: null })}
			/>
			<FilterSidebarBody>
				<FilterSection
					title="Type"
					options={typeFacets}
					selected={type ? [type] : []}
					onChange={(vals) => setParams({ type: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={list.serviceFacets}
					selected={service ? [service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={search ?? ""}
				onSearch={(value) => setParams({ q: value ?? null })}
				placeholder="Filter by metric name…"
				className="min-w-48 flex-1"
			/>
			<ToolbarStats className="shrink-0">
				<ToolbarStat value={entries.length} label="metrics" />
				<ToolbarStat value={totalDataPoints} label="datapoints" />
				<RefreshButton advance={timeWindow.advance} since={list.query.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{list.query.isPending ? (
				<ListSkeleton variant="card" rows={6} />
			) : list.query.isError ? (
				<ErrorState label="metrics" error={list.query.error} onRetry={() => list.query.refetch()} />
			) : entries.length === 0 ? (
				<SignalEmptyState
					signal="metrics"
					filtered={activeFilterCount > 0 || !!search}
					onClearFilters={() => setParams({ service: null, type: null, q: null })}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
				/>
			) : (
				<MetricGrid
					entries={entries}
					points={sparklines.data}
					loading={sparklines.isPending}
					query={query}
					dimmed={list.query.isPlaceholderData}
				/>
			)}
		</PageShell>
	)
}

/** Columns for the grid's measured width. */
function columnsFor(width: number): number {
	if (width >= 1000) return 3
	if (width >= 560) return 2
	return 1
}

/**
 * Up to 500 cards, each with a chart: only the rows in view are mounted. The
 * column count follows the scroll container's measured width.
 */
function MetricGrid({
	entries,
	points,
	loading,
	query,
	dimmed,
}: {
	entries: ReadonlyArray<MetricEntry>
	points: ReadonlyMap<string, SparklinePoint[]> | undefined
	loading: boolean
	query: URLSearchParams
	dimmed: boolean
}) {
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const [width, setWidth] = useState(0)
	// Callback ref with cleanup (React 19): observe the container's width.
	const attach = useCallback((node: HTMLDivElement | null) => {
		scrollRef.current = node
		if (!node) return
		const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	const columns = columnsFor(width)
	const virtualizer = useVirtualizer({
		count: Math.ceil(entries.length / columns),
		getScrollElement: () => scrollRef.current,
		estimateSize: () => CARD_ROW_HEIGHT,
		overscan: 4,
	})

	return (
		<div ref={attach} className={cn("h-full overflow-auto", dimmed && "opacity-60 transition-opacity")}>
			<div className="relative m-4" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((row) => (
					<div
						key={row.key}
						className="absolute inset-x-0 grid gap-3"
						style={{
							transform: `translateY(${row.start}px)`,
							gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
						}}
					>
						{entries.slice(row.index * columns, row.index * columns + columns).map((entry) => (
							<MetricPreviewCard
								key={`${entry.metricName} ${entry.metricType}`}
								entry={entry}
								points={points?.get(entry.metricName)}
								loading={loading}
								href={hrefFor(`/metrics/${encodeURIComponent(entry.metricName)}`, query)}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	)
}

function MetricPreviewCard({
	entry,
	points,
	loading,
	href,
}: {
	entry: MetricEntry
	points: ReadonlyArray<SparklinePoint> | undefined
	loading: boolean
	href: string
}) {
	const rows = useMemo(() => previewValues(entry, points ?? []), [entry, points])
	const unit = humanizeUnit(entry.metricUnit, entry.metricName)
	const services =
		entry.serviceNames.length === 1 ? entry.serviceNames[0] : `${entry.serviceNames.length} services`

	return (
		<a
			href={href}
			aria-label={`${entry.metricName}, ${entry.metricType} metric from ${services}`}
			className="group flex h-[124px] flex-col gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
		>
			<div className="flex w-full items-start justify-between gap-2">
				<span className="min-w-0 truncate font-mono text-xs font-medium" title={entry.metricName}>
					{entry.metricName}
				</span>
				<MetricTypeBadge type={entry.metricType} />
			</div>

			<div className="h-12 w-full" aria-hidden="true">
				{rows.length >= 2 ? (
					<StatSparkline
						data={rows}
						color={METRIC_TYPE_COLORS[entry.metricType] ?? "var(--chart-1)"}
						className="h-full w-full"
					/>
				) : (
					<div className="flex h-full items-center text-[10px] text-muted-foreground">
						{loading ? "Loading…" : "One datapoint so far"}
					</div>
				)}
			</div>

			<div className="flex w-full items-center justify-between gap-2 text-[10px] text-muted-foreground">
				<span className="truncate">{services}</span>
				<span className="flex shrink-0 items-center gap-1.5">
					{unit ? (
						<Badge variant="outline" className="px-1 py-0 font-mono text-[9px]">
							{unit}
						</Badge>
					) : null}
					{isCounter(entry) ? "rate" : "avg"}
				</span>
			</div>
		</a>
	)
}

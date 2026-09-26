import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalServiceCatalog, type ServiceCatalogEntry } from "../hooks/use-local-service-catalog"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor, useQueryParams } from "../lib/router"
import { WIDEST_RANGE } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { LinkRow, RowLink } from "../components/row-link"
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

export function ServicesListView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const env = query.get("env") || undefined
	const ns = query.get("ns") || undefined
	const search = query.get("q") || undefined

	const catalog = useLocalServiceCatalog({ env, ns, search }, timeWindow.bounds)
	const { entries } = catalog
	const activeFilterCount = [env, ns].filter(Boolean).length

	const sidebar = (
		<FilterSidebarFrame
			className="w-56 shrink-0 px-4"
			waiting={catalog.query.isFetching || catalog.facetsFetching}
		>
			<FilterSidebarHeader
				canClear={activeFilterCount > 0}
				onClear={() => setParams({ env: null, ns: null })}
			/>
			<FilterSidebarBody>
				<SearchableFilterSection
					title="Environment"
					options={catalog.envFacets}
					selected={env ? [env] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Namespace"
					options={catalog.nsFacets}
					selected={ns ? [ns] : []}
					onChange={(vals) => setParams({ ns: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={search ?? ""}
				onSearch={(value) => setParams({ q: value ?? null })}
				placeholder="Filter by service name…"
				className="min-w-48 flex-1"
			/>
			<ToolbarStats className="shrink-0">
				<ToolbarStat value={entries.length} label="services" />
				<ToolbarStat value={Math.round(catalog.totalErrorCount)} label="errors" danger />
				<RefreshButton advance={timeWindow.advance} since={catalog.query.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{catalog.query.isPending ? (
				<ListSkeleton rows={8} />
			) : catalog.query.isError ? (
				<ErrorState
					label="services"
					error={catalog.query.error}
					onRetry={() => catalog.query.refetch()}
				/>
			) : entries.length === 0 ? (
				<SignalEmptyState
					signal="traces"
					noun="services"
					filtered={activeFilterCount > 0 || !!search}
					onClearFilters={() => setParams({ env: null, ns: null, q: null })}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
				/>
			) : (
				<div
					className={cn("p-4", catalog.query.isPlaceholderData && "opacity-60 transition-opacity")}
				>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Service</TableHead>
									<TableHead className="text-right">Spans</TableHead>
									<TableHead className="text-right">Errors</TableHead>
									<TableHead className="text-right">Error rate</TableHead>
									<TableHead className="text-right">p50</TableHead>
									<TableHead className="text-right">p95</TableHead>
									<TableHead className="text-right">Logs</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{entries.map((entry) => (
									<ServiceRow key={entry.serviceName} entry={entry} query={query} />
								))}
							</TableBody>
						</Table>
					</div>
				</div>
			)}
		</PageShell>
	)
}

function ServiceRow({ entry, query }: { entry: ServiceCatalogEntry; query: URLSearchParams }) {
	return (
		<LinkRow>
			<TableCell>
				<RowLink
					href={hrefFor(`/services/${encodeURIComponent(entry.serviceName)}`, query)}
					className="flex items-center gap-2"
				>
					<ServiceDot serviceName={entry.serviceName} />
					<span className="font-medium">{entry.serviceName}</span>
					{entry.serviceNamespaces.length > 0 ? (
						<span className="truncate text-xs text-muted-foreground">
							{entry.serviceNamespaces.join(", ")}
						</span>
					) : null}
				</RowLink>
			</TableCell>
			<TableCell className="text-right tabular-nums">{formatNumber(entry.spanCount)}</TableCell>
			<TableCell className={cn("text-right tabular-nums", entry.errorCount > 0 && "text-destructive")}>
				{formatNumber(entry.errorCount)}
			</TableCell>
			<TableCell
				className={cn("text-right tabular-nums", entry.errorRate > 0.05 && "text-destructive")}
			>
				{formatErrorRate(entry.errorRate)}
			</TableCell>
			<TableCell className="text-right">
				<LatencyValue ms={entry.p50LatencyMs} scale="p50" />
			</TableCell>
			<TableCell className="text-right">
				<LatencyValue ms={entry.p95LatencyMs} scale="p95" />
			</TableCell>
			<TableCell className="text-right tabular-nums">{formatNumber(entry.logCount)}</TableCell>
		</LinkRow>
	)
}

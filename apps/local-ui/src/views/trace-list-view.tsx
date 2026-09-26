import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { DurationRangeFilter } from "@maple/ui/components/filters/duration-range-filter"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalTraces, type TraceFilters, type TraceRow } from "../hooks/use-local-traces"
import { useLocalTraceFacets } from "../hooks/use-local-trace-facets"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor, useQueryParams } from "../lib/router"
import { formatLocalDateTime, formatRelativeTime, formatUtcTitle, WIDEST_RANGE } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { LinkRow, RowLink } from "../components/row-link"
import { SignalEmptyState } from "../components/signal-empty-state"
import {
	Toolbar,
	ToolbarSearch,
	ToolbarStat,
	ToolbarStats,
	TimeRangeSelect,
	RefreshButton,
} from "../components/toolbar"
import { ErrorState, ListSkeleton } from "../components/view-states"

/** Parse a URL param as a non-negative integer; anything else means "unset". */
function parseNonNegativeInt(raw: string | null): number | undefined {
	if (!raw) return undefined
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
}

const FILTER_KEYS = [
	"service",
	"span",
	"errors",
	"method",
	"status",
	"env",
	"ns",
	"minDur",
	"maxDur",
] as const

export function TraceListView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const spanScope = query.get("scope") === "spans"
	const search = query.get("q") || undefined

	const filters: TraceFilters = {
		search,
		service: query.get("service") || undefined,
		span: query.get("span") || undefined,
		errorsOnly: query.get("errors") === "1",
		method: query.get("method") || undefined,
		status: query.get("status") || undefined,
		env: query.get("env") || undefined,
		ns: query.get("ns") || undefined,
		minDurationMs: parseNonNegativeInt(query.get("minDur")),
		maxDurationMs: parseNonNegativeInt(query.get("maxDur")),
		scope: spanScope ? "spans" : "root",
	}

	const facets = useLocalTraceFacets(filters, timeWindow.bounds, !spanScope)
	const traces = useLocalTraces(filters, timeWindow.bounds)
	const rows = traces.data?.pages.flat() ?? []

	const activeFilterCount = FILTER_KEYS.filter((key) => query.get(key)).length
	const clearFilters = () =>
		setParams({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null, scope: null })

	// Single-select facet adapter: the list query takes one value per dimension.
	const facetSelect = (key: string) => (vals: string[]) => setParams({ [key]: vals.at(-1) ?? null })

	const sidebar = spanScope ? (
		<FilterSidebarFrame className="w-56 shrink-0 px-4">
			<FilterSidebarHeader title="Span search" canClear onClear={clearFilters} />
			<FilterSidebarBody>
				<p className="py-1 text-xs text-muted-foreground">
					Matching any span in a trace, not only its root. Root-span facets are off in this mode.
				</p>
				<SingleCheckboxFilter
					title="Errored spans only"
					checked={filters.errorsOnly === true}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
				/>
				<Button
					variant="outline"
					size="sm"
					className="mt-2 w-full"
					onClick={() => setParams({ scope: null })}
				>
					Filter root spans instead
				</Button>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	) : (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader canClear={activeFilterCount > 0} onClear={clearFilters} />
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Errors only"
					checked={filters.errorsOnly === true}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
					count={facets.data?.errorCount}
				/>
				<FilterSection
					title="Environment"
					options={facets.data?.deploymentEnvs ?? []}
					selected={filters.env ? [filters.env] : []}
					onChange={facetSelect("env")}
				/>
				<SearchableFilterSection
					title="Namespace"
					options={facets.data?.namespaces ?? []}
					selected={filters.ns ? [filters.ns] : []}
					onChange={facetSelect("ns")}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={facetSelect("service")}
				/>
				<SearchableFilterSection
					title="Root Span"
					options={facets.data?.spanNames ?? []}
					selected={filters.span ? [filters.span] : []}
					onChange={facetSelect("span")}
				/>
				<DurationRangeFilter
					minValue={filters.minDurationMs}
					maxValue={filters.maxDurationMs}
					onRangeChange={(min, max) =>
						setParams({
							minDur: min != null ? String(Math.round(min)) : null,
							maxDur: max != null ? String(Math.round(max)) : null,
						})
					}
					durationStats={facets.data?.durationStats}
					debounceMs={300}
				/>
				<FilterSection
					title="HTTP Method"
					options={facets.data?.httpMethods ?? []}
					selected={filters.method ? [filters.method] : []}
					onChange={facetSelect("method")}
				/>
				<FilterSection
					title="Status Code"
					options={facets.data?.httpStatusCodes ?? []}
					selected={filters.status ? [filters.status] : []}
					onChange={facetSelect("status")}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			{spanScope ? (
				<SpanScopeBanner
					service={filters.service}
					span={filters.span}
					onExit={() => setParams({ scope: null })}
				/>
			) : null}
			{spanScope && filters.span ? null : (
				<ToolbarSearch
					query={search ?? ""}
					onSearch={(value) => setParams({ q: value ?? null })}
					placeholder={spanScope ? "Filter by any span name…" : "Filter by span name…"}
					className="min-w-48 flex-1"
				/>
			)}
			<ToolbarStats className="shrink-0">
				<ToolbarStat value={rows.length} label={traces.hasNextPage ? "traces+" : "traces"} />
				<RefreshButton advance={timeWindow.advance} since={traces.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{traces.isPending ? (
				<ListSkeleton variant="table" />
			) : traces.isError ? (
				<ErrorState label="traces" error={traces.error} onRetry={() => traces.refetch()} />
			) : rows.length === 0 ? (
				<SignalEmptyState
					signal="traces"
					filtered={activeFilterCount > 0 || !!search}
					onClearFilters={clearFilters}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
				/>
			) : (
				<div className={cn(traces.isPlaceholderData && "opacity-60 transition-opacity")}>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[40%]">Trace</TableHead>
								<TableHead>Services</TableHead>
								<TableHead className="text-right">Duration</TableHead>
								<TableHead className="text-right">Spans</TableHead>
								<TableHead className="text-right">Started</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TraceListRow key={row.traceId} row={row} query={query} />
							))}
						</TableBody>
					</Table>

					{traces.hasNextPage ? (
						<div className="flex justify-center p-4">
							<Button
								variant="outline"
								size="sm"
								onClick={() => traces.fetchNextPage()}
								disabled={traces.isFetchingNextPage}
							>
								{traces.isFetchingNextPage ? <Spinner className="size-4" /> : "Load more"}
							</Button>
						</div>
					) : null}
				</div>
			)}
		</PageShell>
	)
}

function SpanScopeBanner({
	service,
	span,
	onExit,
}: {
	service: string | undefined
	span: string | undefined
	onExit: () => void
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
			<span className="text-muted-foreground">Traces containing a span</span>
			{service ? (
				<>
					<span className="text-muted-foreground">from</span>
					<Badge variant="outline" className="font-mono text-xs">
						{service}
					</Badge>
				</>
			) : null}
			{span ? (
				<>
					<span className="text-muted-foreground">named</span>
					<Badge variant="outline" className="max-w-64 truncate font-mono text-xs" title={span}>
						{span}
					</Badge>
				</>
			) : null}
			<Button variant="ghost" size="xs" onClick={onExit}>
				Root spans only
			</Button>
		</div>
	)
}

function TraceListRow({ row, query }: { row: TraceRow; query: URLSearchParams }) {
	const href = hrefFor(`/traces/${encodeURIComponent(row.traceId)}`, query)
	return (
		<LinkRow className={cn(row.hasError && "bg-destructive/5")}>
			<TableCell className="min-w-0">
				<RowLink
					href={href}
					label={`Trace ${row.rootSpanName || row.traceId}`}
					className="flex items-center gap-2"
				>
					{row.hasError ? (
						<span className="size-1.5 shrink-0 rounded-full bg-destructive">
							<span className="sr-only">Errored</span>
						</span>
					) : null}
					<HttpSpanLabel
						spanName={row.rootSpanName}
						spanKind={row.rootSpanKind}
						spanAttributes={row.rootSpanAttributes}
						className="min-w-0"
					/>
				</RowLink>
			</TableCell>
			<TableCell className="text-muted-foreground">
				<div className="flex flex-wrap gap-1">
					{row.services.slice(0, 3).map((svc) => (
						<Badge key={svc} variant="secondary" className="font-mono text-[10px]">
							{svc}
						</Badge>
					))}
					{row.services.length > 3 ? (
						<Badge variant="secondary" className="font-mono text-[10px]">
							+{row.services.length - 3}
						</Badge>
					) : null}
				</div>
			</TableCell>
			<TableCell className="text-right font-mono tabular-nums">
				{formatDuration(row.durationMs)}
			</TableCell>
			<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
				{row.spanCount ?? "-"}
			</TableCell>
			<TableCell
				className="text-right text-xs whitespace-nowrap text-muted-foreground"
				title={`${formatLocalDateTime(row.startTime)} (${formatUtcTitle(row.startTime)})`}
			>
				{formatRelativeTime(row.startTime)}
			</TableCell>
		</LinkRow>
	)
}

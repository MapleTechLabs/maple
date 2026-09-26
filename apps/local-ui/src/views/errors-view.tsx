import { useState } from "react"
import { CircleWarningIcon, ChevronDownIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { formatDuration, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	SearchableFilterSection,
	SingleCheckboxFilter,
	serviceColorMap,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import {
	useLocalErrorTraces,
	useLocalErrorsByType,
	useLocalErrorsFacets,
	useLocalErrorsSummary,
	type ErrorsFilters,
	type ErrorTypeRow,
} from "../hooks/use-local-errors"
import { useRange } from "../hooks/use-range"
import { useSignalPresence } from "../hooks/use-signal-presence"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor, useQueryParams } from "../lib/router"
import { formatRelativeTime, WIDEST_RANGE, type TimeBounds } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { SignalEmptyState } from "../components/signal-empty-state"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

export function ErrorsView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const filters: ErrorsFilters = {
		service: query.get("service") || undefined,
		env: query.get("env") || undefined,
		rootOnly: query.get("root") === "1",
	}
	const summary = useLocalErrorsSummary(filters, timeWindow.bounds)
	const byType = useLocalErrorsByType(filters, timeWindow.bounds)
	const facets = useLocalErrorsFacets(filters, timeWindow.bounds)
	const traces = useSignalPresence("traces")
	const activeFilterCount = [filters.service, filters.env, filters.rootOnly].filter(Boolean).length
	const clearFilters = () => setParams({ service: null, env: null, root: null })

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader canClear={activeFilterCount > 0} onClear={clearFilters} />
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Root spans only"
					checked={filters.rootOnly === true}
					onChange={(checked) => setParams({ root: checked ? "1" : null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
					colorMap={serviceColorMap(facets.data?.services ?? [])}
				/>
				<SearchableFilterSection
					title="Environment"
					options={facets.data?.environments ?? []}
					selected={filters.env ? [filters.env] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const stats = summary.data
	const toolbar = (
		<Toolbar>
			<ToolbarStats className="flex-wrap">
				<ToolbarStat value={Math.round(stats?.totalErrors ?? 0)} label="errors" danger />
				<ToolbarStat value={Math.round(stats?.affectedTracesCount ?? 0)} label="affected traces" />
				<span className="text-sm whitespace-nowrap text-muted-foreground">
					<span className="font-medium tabular-nums text-foreground">
						{formatErrorRate(stats?.errorRate ?? 0)}
					</span>{" "}
					error rate
				</span>
			</ToolbarStats>
			<ToolbarStats className="shrink-0">
				<RefreshButton advance={timeWindow.advance} since={byType.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	const rows = byType.data ?? []

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{byType.isPending ? (
				<ListSkeleton variant="card" rows={6} />
			) : byType.isError ? (
				<ErrorState label="errors" error={byType.error} onRetry={() => byType.refetch()} />
			) : rows.length === 0 ? (
				activeFilterCount === 0 && traces.status === "present" ? (
					<EmptyState
						icon={<CircleWarningIcon />}
						title="No errors in this range"
						hint="Errors appear when spans arrive with an Error status. None did in the selected window."
					/>
				) : (
					<SignalEmptyState
						signal="traces"
						noun="errors"
						filtered={activeFilterCount > 0}
						onClearFilters={clearFilters}
						range={range}
						onWidenRange={() => setRange(WIDEST_RANGE)}
					/>
				)
			) : (
				<div
					className={cn(
						"space-y-2 p-4",
						byType.isPlaceholderData && "opacity-60 transition-opacity",
					)}
				>
					{rows.map((row) => (
						<ErrorTypeCard
							key={row.fingerprintHash}
							row={row}
							filters={filters}
							bounds={timeWindow.bounds}
							query={query}
						/>
					))}
				</div>
			)}
		</PageShell>
	)
}

/** The current view's params, plus the error span to focus when the trace has one. */
function traceLinkParams(query: URLSearchParams, errorSpanId: string): URLSearchParams {
	const params = new URLSearchParams(Object.fromEntries(query))
	if (errorSpanId) params.set("spanId", errorSpanId)
	return params
}

function ErrorTypeCard({
	row,
	filters,
	bounds,
	query,
}: {
	row: ErrorTypeRow
	filters: ErrorsFilters
	bounds: TimeBounds
	query: URLSearchParams
}) {
	const [expanded, setExpanded] = useState(false)
	const traces = useLocalErrorTraces(expanded ? row.fingerprintHash : undefined, filters, bounds)
	const panelId = `error-traces-${row.fingerprintHash}`

	return (
		<div className="rounded-md border bg-card">
			<button
				type="button"
				onClick={() => setExpanded((prev) => !prev)}
				aria-expanded={expanded}
				aria-controls={panelId}
				className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<CircleWarningIcon className="size-4 shrink-0 text-destructive" />
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className="truncate text-sm font-medium">
							{row.errorLabel || "Unknown Error"}
						</span>
						{row.serviceNames.length > 0 ? (
							<>
								{row.serviceNames.map((serviceName) => (
									<Badge
										key={serviceName}
										variant="outline"
										className="gap-1.5 font-mono text-[10px]"
									>
										<ServiceDot serviceName={serviceName} />
										{serviceName}
									</Badge>
								))}
								{row.affectedServicesCount > row.serviceNames.length ? (
									<span className="shrink-0 text-xs text-muted-foreground">
										+{row.affectedServicesCount - row.serviceNames.length} more
									</span>
								) : null}
							</>
						) : (
							<span className="shrink-0 text-xs text-muted-foreground">
								{row.affectedServicesCount === 1
									? "1 service"
									: `${row.affectedServicesCount} services`}
							</span>
						)}
					</span>
					{row.sampleMessage ? (
						<span className="block truncate font-mono text-xs text-muted-foreground">
							{row.sampleMessage}
						</span>
					) : null}
				</span>
				<span className="shrink-0 text-right">
					<span className="block text-sm font-semibold tabular-nums text-destructive">
						{formatNumber(row.count)}
					</span>
					<span className="block text-[10px] text-muted-foreground">
						last seen {formatRelativeTime(row.lastSeen)}
					</span>
				</span>
				<ChevronDownIcon
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-180",
					)}
				/>
			</button>

			{expanded ? (
				<div id={panelId} className="border-t px-4 py-2">
					{traces.isPending ? (
						<div className="flex h-16 items-center justify-center">
							<Spinner className="size-4" />
						</div>
					) : traces.isError ? (
						<ErrorState label="traces" error={traces.error} onRetry={() => traces.refetch()} />
					) : (traces.data ?? []).length === 0 ? (
						<p className="py-2 text-xs text-muted-foreground">
							No traces found for this error in the selected range.
						</p>
					) : (
						<ul className="divide-y">
							{(traces.data ?? []).map((trace) => (
								<li key={trace.traceId}>
									<a
										href={hrefFor(
											`/traces/${encodeURIComponent(trace.traceId)}`,
											traceLinkParams(query, trace.errorSpanId),
										)}
										className="flex w-full items-center gap-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
									>
										<span className="min-w-0 flex-1 truncate font-mono">
											{trace.errorSpanName || trace.rootSpanName || trace.traceId}
											{trace.errorServiceName ? (
												<span className="ml-2 text-muted-foreground/70">
													{trace.errorServiceName}
												</span>
											) : null}
										</span>
										<span className="shrink-0 tabular-nums">{trace.spanCount} spans</span>
										<span className="shrink-0 tabular-nums">
											{formatDuration(trace.durationMicros / 1000)}
										</span>
										<span className="shrink-0 tabular-nums">
											{formatRelativeTime(trace.startTime)}
										</span>
									</a>
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	)
}

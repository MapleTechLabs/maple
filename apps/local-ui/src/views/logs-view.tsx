import { useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Separator } from "@maple/ui/components/ui/separator"
import type { LogsListOutput } from "@maple/query-engine/ch"
import { useLocalLogs, useLocalLogSeverities } from "../hooks/use-local-logs"
import { useLocalServices } from "../hooks/use-local-services"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { FilterSection, SearchableFilterSection } from "../components/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "../components/filter-sidebar"
import { PageShell } from "../components/page-shell"
import { Toolbar, ToolbarSearch, ToolbarStat, TimeRangeSelect } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"

const ROW_HEIGHT = 40

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const severity = query.get("severity") || undefined
	const search = query.get("q") || undefined

	const services = useLocalServices(range)
	const severities = useLocalLogSeverities(range)
	const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalLogs({ service, severity, search, range })

	const rows: ReadonlyArray<LogsListOutput> = data?.pages.flat() ?? []
	const scrollRef = useRef<HTMLDivElement>(null)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	})

	const virtualItems = virtualizer.getVirtualItems()
	useEffect(() => {
		const last = virtualItems[virtualItems.length - 1]
		if (!last) return
		if (last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

	const hasActiveFilters = !!service || !!severity

	const sidebar = (
		<FilterSidebarFrame waiting={services.isFetching || severities.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, severity: null })}
			/>
			<FilterSidebarBody>
				{(severities.data?.length ?? 0) > 0 && (
					<FilterSection
						title="Severity"
						options={(severities.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
						selected={severity ? [severity] : []}
						onChange={(vals) => setParams({ severity: vals.at(-1) ?? null })}
					/>
				)}
				{(services.data?.length ?? 0) > 0 && (
					<>
						<Separator className="my-2" />
						<SearchableFilterSection
							title="Service"
							options={(services.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
							selected={service ? [service] : []}
							onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
						/>
					</>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar
			search={
				<ToolbarSearch
					query={search ?? ""}
					onSearch={(value) => setParams({ q: value ?? null })}
					placeholder="Search log bodies…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={rows.length} label={hasNextPage ? "logs+" : "logs"} />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{isPending ? (
				<div className="flex h-full items-center justify-center">
					<Spinner />
				</div>
			) : isError ? (
				<ErrorState label="logs" error={error} />
			) : rows.length === 0 ? (
				<EmptyState
					title={hasActiveFilters || search ? "No matching logs" : "No logs yet"}
					hint={
						hasActiveFilters || search
							? "Try widening the time range or clearing filters."
							: "Send OTLP logs to the local ingest endpoint to get started."
					}
				/>
			) : (
				<div ref={scrollRef} className="h-full overflow-auto">
					<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{virtualItems.map((virtualRow) => {
							const log = rows[virtualRow.index]
							return (
								<div
									key={virtualRow.key}
									className="absolute inset-x-0 flex items-center gap-3 border-b px-4 font-mono text-xs"
									style={{
										height: virtualRow.size,
										transform: `translateY(${virtualRow.start}px)`,
									}}
								>
									<span className="w-44 shrink-0 text-muted-foreground">{log.timestamp}</span>
									<SeverityBadge severity={log.severityText || "info"} className="shrink-0" />
									<span className="w-40 shrink-0 truncate text-muted-foreground" title={log.serviceName}>
										{log.serviceName}
									</span>
									<span className="min-w-0 flex-1 truncate" title={log.body}>
										{log.body}
									</span>
								</div>
							)
						})}
					</div>
					{isFetchingNextPage ? (
						<div className="flex justify-center p-3">
							<Spinner className="size-4" />
						</div>
					) : null}
				</div>
			)}
		</PageShell>
	)
}

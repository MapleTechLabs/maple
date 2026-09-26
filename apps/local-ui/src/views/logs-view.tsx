import { useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { LogAttributeChip } from "@maple/ui/components/logs/log-attribute-chip"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { FilterSection, SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalLogs, useLocalLogSeverities, type LogFilters } from "../hooks/use-local-logs"
import { useLocalLogServices } from "../hooks/use-local-log-services"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { useQueryParams } from "../lib/router"
import { formatLocalTimestamp, formatUtcTitle, WIDEST_RANGE } from "../lib/time"
import { logKey, type LocalLog } from "../lib/log-shape"
import { LogDetailSheet } from "../components/log-detail-sheet"
import { HighlightedText } from "../components/highlighted-text"
import { PageShell } from "../components/page-shell"
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

const ROW_HEIGHT = 36
const VISIBLE_CHIPS = 4

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const filters: LogFilters = {
		service: query.get("service") || undefined,
		severity: query.get("severity") || undefined,
		search: query.get("q") || undefined,
	}

	const services = useLocalLogServices(filters, timeWindow.bounds)
	const severities = useLocalLogSeverities(filters, timeWindow.bounds)
	const logs = useLocalLogs(filters, timeWindow.bounds)
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = logs

	const rows = useMemo<ReadonlyArray<LocalLog>>(() => logs.data?.pages.flat() ?? [], [logs.data])
	const scrollRef = useRef<HTMLDivElement>(null)

	const [selectedLog, setSelectedLog] = useState<LocalLog | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)
	const selectedKey = selectedLog ? logKey(selectedLog) : null

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
		// Load the next page as the last row scrolls into view.
		onChange: (instance) => {
			const last = instance.getVirtualItems().at(-1)
			if (last && last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage)
				void fetchNextPage()
		},
	})

	const openLog = (log: LocalLog) => {
		setSelectedLog(log)
		setSheetOpen(true)
	}

	const activeFilterCount = [filters.service, filters.severity].filter(Boolean).length
	const clearFilters = () => setParams({ service: null, severity: null, q: null })

	const sidebar = (
		<FilterSidebarFrame
			className="w-56 shrink-0 px-4"
			waiting={services.isFetching || severities.isFetching}
		>
			<FilterSidebarHeader
				canClear={activeFilterCount > 0}
				onClear={() => setParams({ service: null, severity: null })}
			/>
			<FilterSidebarBody>
				<FilterSection
					title="Severity"
					options={severities.data ?? []}
					selected={filters.severity ? [filters.severity] : []}
					onChange={(vals) => setParams({ severity: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={services.data ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={filters.search ?? ""}
				onSearch={(value) => setParams({ q: value ?? null })}
				placeholder="Search log bodies…"
				className="min-w-48 flex-1"
			/>
			<ToolbarStats className="shrink-0">
				<ToolbarStat value={rows.length} label={hasNextPage ? "logs+" : "logs"} />
				<RefreshButton advance={timeWindow.advance} since={logs.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{logs.isPending ? (
				<ListSkeleton variant="table" />
			) : logs.isError ? (
				<ErrorState label="logs" error={logs.error} onRetry={() => logs.refetch()} />
			) : rows.length === 0 ? (
				<SignalEmptyState
					signal="logs"
					filtered={activeFilterCount > 0 || !!filters.search}
					onClearFilters={clearFilters}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
				/>
			) : (
				<div
					ref={scrollRef}
					role="list"
					aria-label="Logs"
					className={cn(
						"h-full overflow-auto",
						logs.isPlaceholderData && "opacity-60 transition-opacity",
					)}
				>
					<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{virtualizer.getVirtualItems().map((virtualRow) => {
							const log = rows[virtualRow.index]
							return (
								<LogRow
									key={virtualRow.key}
									log={log}
									search={filters.search}
									top={virtualRow.start}
									height={virtualRow.size}
									selected={selectedKey === logKey(log)}
									onClick={openLog}
								/>
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

			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={setSheetOpen} />
		</PageShell>
	)
}

function LogRow({
	log,
	search,
	top,
	height,
	selected,
	onClick,
}: {
	log: LocalLog
	search: string | undefined
	top: number
	height: number
	selected: boolean
	onClick: (log: LocalLog) => void
}) {
	const chips = useMemo(() => pickImportantAttributes(log, VISIBLE_CHIPS), [log])
	const severityColor = getSeverityColor(log.severityText)

	return (
		<div
			data-selected={selected || undefined}
			style={{
				position: "absolute",
				insetInline: 0,
				top: 0,
				transform: `translateY(${top}px)`,
				height,
				borderLeftWidth: "3px",
				borderLeftColor: severityColor,
			}}
			className="flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none data-[selected]:bg-primary/5"
			tabIndex={0}
			role="listitem"
			aria-label={`${log.severityText} ${log.serviceName}: ${log.body.slice(0, 120)}`}
			onClick={() => onClick(log)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onClick(log)
				}
			}}
		>
			<span
				className="hidden w-12 shrink-0 text-[10px] font-semibold uppercase tabular-nums md:inline-block"
				style={{ color: severityColor }}
			>
				{log.severityText}
			</span>
			<span
				className="w-36 shrink-0 truncate text-muted-foreground tabular-nums"
				title={formatUtcTitle(log.timestamp)}
			>
				{formatLocalTimestamp(log.timestamp)}
			</span>
			<span
				className="hidden w-32 shrink-0 truncate text-muted-foreground/70 lg:inline-block"
				title={log.serviceName}
			>
				{log.serviceName}
			</span>
			{/* The message has priority: it keeps at least 40% of the row, and chips
			    that do not fit wrap onto a clipped second line instead of squeezing it. */}
			<span className="min-w-[40%] flex-1 truncate" title={log.body}>
				<HighlightedText text={log.body} query={search} />
			</span>
			{chips.length > 0 && (
				<div className="hidden h-5 min-w-0 max-w-[30%] flex-wrap items-center justify-end gap-1 overflow-hidden md:flex">
					{chips.map((chip) => (
						<LogAttributeChip
							key={chip.key}
							attrKey={chip.key}
							value={chip.value}
							tone={chip.tone}
						/>
					))}
				</div>
			)}
		</div>
	)
}

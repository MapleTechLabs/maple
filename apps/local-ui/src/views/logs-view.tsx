import { useMemo, useRef, useState, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { LogPattern } from "@maple/query-engine/observability"
import { LogAttributeChip } from "@maple/ui/components/logs/log-attribute-chip"
import { severityLabel } from "@maple/ui/components/logs/severity-badge"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Badge } from "@maple/ui/components/ui/badge"
import { countLabel } from "@maple/ui/lib/format"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { getSeverityColor, SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import {
	FilterSection,
	SearchableFilterSection,
	serviceColorMap,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalLogs, useLocalLogSeverities, type LogFilters } from "../hooks/use-local-logs"
import { useLocalLogPatterns } from "../hooks/use-local-log-patterns"
import { useLocalLogServices } from "../hooks/use-local-log-services"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { useQueryParams } from "../lib/router"
import { formatLocalTimestamp, formatUtcTitle, WIDEST_RANGE, type TimeBounds } from "../lib/time"
import { logKey, type LocalLog } from "../lib/log-shape"
import { patternSearchTerm } from "../lib/log-patterns"
import { LogDetailSheet } from "../components/log-detail-sheet"
import { LogPatternsList } from "../components/log-patterns-list"
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
const VISIBLE_CHIPS = 3

type LogsMode = "list" | "patterns"

/** Wraps a mode's body in the shared page chrome; each mode supplies its own stat and freshness. */
type RenderPage = (props: { stat: ReactNode; since: number; children: ReactNode }) => ReactNode

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const mode: LogsMode = query.get("mode") === "patterns" ? "patterns" : "list"
	const filters: LogFilters = {
		service: query.get("service") || undefined,
		severity: query.get("severity") || undefined,
		search: query.get("q") || undefined,
	}

	const services = useLocalLogServices(filters, timeWindow.bounds)
	const severities = useLocalLogSeverities(filters, timeWindow.bounds)

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
					colorMap={SEVERITY_COLORS}
				/>
				<SearchableFilterSection
					title="Service"
					options={services.data ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
					colorMap={serviceColorMap(services.data ?? [])}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const renderPage: RenderPage = ({ stat, since, children }) => (
		<PageShell
			sidebar={sidebar}
			activeFilterCount={activeFilterCount}
			toolbar={
				<Toolbar>
					<ToggleGroup
						value={[mode]}
						onValueChange={(values) => {
							const next = values.find((value) => value !== mode)
							if (next === "list" || next === "patterns")
								setParams({ mode: next === "patterns" ? next : null })
						}}
						variant="outline"
						size="sm"
						aria-label="Logs view"
						className="shrink-0"
					>
						<ToggleGroupItem value="list">List</ToggleGroupItem>
						<ToggleGroupItem value="patterns">Patterns</ToggleGroupItem>
					</ToggleGroup>
					<ToolbarSearch
						query={filters.search ?? ""}
						onSearch={(value) => setParams({ q: value ?? null })}
						placeholder="Search log bodies…"
						className="min-w-48 flex-1"
					/>
					<ToolbarStats className="shrink-0">
						{stat}
						<RefreshButton advance={timeWindow.advance} since={since} />
						<TimeRangeSelect value={range} onChange={setRange} />
					</ToolbarStats>
				</Toolbar>
			}
		>
			{children}
		</PageShell>
	)

	const emptyState = (
		<SignalEmptyState
			signal="logs"
			filtered={activeFilterCount > 0 || !!filters.search}
			onClearFilters={clearFilters}
			range={range}
			onWidenRange={() => setRange(WIDEST_RANGE)}
		/>
	)

	// Each mode is its own component so only the active mode's query runs:
	// chDB serves one query at a time.
	return mode === "patterns" ? (
		<LogPatternsMode
			filters={filters}
			bounds={timeWindow.bounds}
			renderPage={renderPage}
			emptyState={emptyState}
			onSelect={(pattern) =>
				setParams({ mode: null, q: patternSearchTerm(pattern.template) || filters.search })
			}
		/>
	) : (
		<LogListMode
			filters={filters}
			bounds={timeWindow.bounds}
			renderPage={renderPage}
			emptyState={emptyState}
		/>
	)
}

function LogPatternsMode({
	filters,
	bounds,
	renderPage,
	emptyState,
	onSelect,
}: {
	filters: LogFilters
	bounds: TimeBounds
	renderPage: RenderPage
	emptyState: ReactNode
	onSelect: (pattern: LogPattern) => void
}) {
	const patterns = useLocalLogPatterns(filters, bounds)
	const data = patterns.data
	const stat = data ? (
		<>
			<ToolbarStat value={data.patterns.length} label="patterns" />
			<span title={data.truncated ? "Clustered from the newest logs only" : undefined}>
				<ToolbarStat value={data.totalSampled} label={data.truncated ? "logs+" : "logs"} />
			</span>
		</>
	) : null

	return renderPage({
		stat,
		since: patterns.dataUpdatedAt,
		children: patterns.isPending ? (
			<ListSkeleton variant="table" />
		) : patterns.isError ? (
			<ErrorState label="log patterns" error={patterns.error} onRetry={() => patterns.refetch()} />
		) : data === undefined || data.patterns.length === 0 ? (
			emptyState
		) : (
			<LogPatternsList
				patterns={data.patterns}
				totalSampled={data.totalSampled}
				dimmed={patterns.isPlaceholderData}
				onSelect={onSelect}
			/>
		),
	})
}

function LogListMode({
	filters,
	bounds,
	renderPage,
	emptyState,
}: {
	filters: LogFilters
	bounds: TimeBounds
	renderPage: RenderPage
	emptyState: ReactNode
}) {
	const logs = useLocalLogs(filters, bounds)
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

	return renderPage({
		stat: <ToolbarStat value={rows.length} label={hasNextPage ? "logs+" : "logs"} />,
		since: logs.dataUpdatedAt,
		children: (
			<>
				{logs.isPending ? (
					<ListSkeleton variant="table" />
				) : logs.isError ? (
					<ErrorState label="logs" error={logs.error} onRetry={() => logs.refetch()} />
				) : rows.length === 0 ? (
					emptyState
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
			</>
		),
	})
}

/** Left-edge rail (and, for errors, a tint) so a scan down the stream stops on what is wrong. */
const SEVERITY_ROW = new Map([
	["FATAL", "before:bg-severity-error bg-severity-error/[0.08]"],
	["CRITICAL", "before:bg-severity-error bg-severity-error/[0.08]"],
	["ERROR", "before:bg-severity-error bg-severity-error/[0.05]"],
	["WARN", "before:bg-severity-warn"],
	["WARNING", "before:bg-severity-warn"],
])

/** Debug and trace chatter is read last, so its message is set back a step. */
const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])

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
	// Only chips that add to the message: resource attributes repeat down the whole
	// stream, and a value the body already spells out is said twice.
	const chips = useMemo(
		() =>
			pickImportantAttributes(log, Number.POSITIVE_INFINITY)
				.filter(
					(attr) =>
						attr.source === "log" && !(attr.value.length >= 3 && log.body.includes(attr.value)),
				)
				.slice(0, VISIBLE_CHIPS),
		[log],
	)
	// ANSI color codes are stripped for display only; copy and Raw keep the original.
	// The row shows one line: the first, or the first that matches the search, so a
	// hit further down a multi-line body is still visible in the row.
	const firstLine = useMemo(() => {
		const lines = stripAnsi(log.body).split("\n")
		const needle = search?.toLowerCase()
		const match = needle ? lines.find((line) => line.toLowerCase().includes(needle)) : undefined
		return { text: match ?? lines[0] ?? "", hidden: lines.length - 1 }
	}, [log.body, search])
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()

	return (
		<div
			data-selected={selected || undefined}
			style={{
				position: "absolute",
				insetInline: 0,
				top: 0,
				transform: `translateY(${top}px)`,
				height,
			}}
			className={cn(
				"flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs",
				"before:absolute before:inset-y-0 before:left-0 before:w-0.5",
				"hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none data-[selected]:bg-primary/5",
				SEVERITY_ROW.get(severity),
			)}
			tabIndex={0}
			role="listitem"
			aria-label={`${severity} ${log.serviceName}: ${log.body.slice(0, 120)}`}
			onClick={() => onClick(log)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onClick(log)
				}
			}}
		>
			<span
				className="w-36 shrink-0 truncate text-foreground/75 tabular-nums"
				title={formatUtcTitle(log.timestamp)}
			>
				{formatLocalTimestamp(log.timestamp)}
			</span>
			<span
				className="hidden w-11 shrink-0 truncate text-3xs font-semibold tracking-wide uppercase tabular-nums md:inline-block"
				style={{ color: getSeverityColor(severity) }}
				title={severity}
			>
				{severity}
			</span>
			<span className="hidden w-32 min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground lg:flex">
				<ServiceDot serviceName={log.serviceName} size="sm" />
				<span className="truncate" title={log.serviceName}>
					{log.serviceName}
				</span>
			</span>
			{/* The message has priority: it keeps at least 40% of the row, and chips
			    that do not fit wrap onto a clipped second line instead of squeezing it. */}
			<span className="flex min-w-[40%] flex-1 items-center gap-2" title={log.body}>
				<span
					className={cn(
						"min-w-0 truncate",
						QUIET_SEVERITIES.has(severity) ? "text-muted-foreground" : "text-foreground",
					)}
				>
					<HighlightedText text={firstLine.text} query={search} />
				</span>
				{firstLine.hidden > 0 && (
					<Badge variant="meta" size="xs" className="shrink-0">
						+{countLabel(firstLine.hidden, "line")}
					</Badge>
				)}
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

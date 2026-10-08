import { refreshingClass } from "@maple/ui/lib/refreshing"
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Result } from "@/lib/effect-atom"
import { ExcludedEmptyHint } from "@maple/ui/components/filters/excluded-empty-hint"
import { SignalEmptyState } from "@/components/common/signal-empty-state"
import { logFilterChips } from "@/lib/logs/log-filter-chips"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useHotkeys } from "@tanstack/react-hotkeys"

import { cn } from "@maple/ui/lib/utils"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { type Log } from "@/api/warehouse/logs"
import { LogDetailSheet } from "./log-detail-sheet"
import { LogRowExpanded } from "./log-row-expanded"
import { LogsTableToolbar } from "./logs-table-toolbar"
import type { LogsSearchParams } from "@/routes/logs"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { useLogsViewPreferences, type LogsDensity } from "@/hooks/use-logs-view-preferences"
import { formatCompactTimeInTimezone } from "@/lib/timezone-format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { isDialogOpen } from "@maple/ui/lib/keyboard"
import { useInfiniteLogs, FETCH_THRESHOLD } from "@/hooks/use-infinite-logs"
import { useVirtualReachEnd } from "@/components/common/reach-end-sentinel"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { pickImportantAttributes } from "@/lib/log-attributes"
import { LogAttributeChip } from "./log-attribute-chip"
import { HighlightedText } from "./highlighted-text"
import { shortId } from "@maple/ui/lib/ids"
import { ChevronRightIcon, CopyIcon, ExternalLinkIcon, PulseIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { usePageScrolledReporter } from "@maple/ui/components/ui/page-layout"
import { DocsLink } from "@/components/common/docs-link"
import {
	applyTimeRangeSearch,
	canWidenTimeRange,
	WIDEN_TIME_PRESET,
} from "@/components/time-range-picker/search"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

const ROW_HEIGHT = 30
const ROW_HEIGHT_COMFORTABLE = 42
const PINNED_COL_WIDTH = "150px"
/** Chips shown beside the message; the rest are one expand away. */
const MAX_INLINE_CHIPS = 3

const EMPTY_COLUMNS: string[] = []

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

/** First line of a multi-line body (a stack trace, a dump) and how many lines the row hides. */
function splitFirstLine(body: string): { first: string; hidden: number } {
	const lines = body.split("\n")
	return { first: lines[0] ?? "", hidden: lines.length - 1 }
}

/** What the stream reports up, so a page can hold its live tail while someone reads. */
export interface LogsInspectState {
	/** Pointer over the stream, a row expanded, the detail drawer open, or scrolled down. */
	inspecting: boolean
	/** Scrolled away from the newest rows, the one cause "Jump to latest" undoes by itself. */
	scrolledAway: boolean
}

export interface LogsStreamHandle {
	/** Back to the newest rows: scroll to the top and collapse every expanded row. */
	jumpToLatest: () => void
}

interface InspectInputs {
	hovering: boolean
	scrolledAway: boolean
	expanded: boolean
	detail: boolean
}

const NOT_INSPECTING: LogsInspectState = { inspecting: false, scrolledAway: false }
const NO_INSPECT_INPUTS: InspectInputs = {
	hovering: false,
	scrolledAway: false,
	expanded: false,
	detail: false,
}
const NO_EXPANDED_ROWS: ReadonlySet<number> = new Set()

interface LogsTableViewProps {
	allData: Log[]
	isFetchingNextPage: boolean
	hasNextPage: boolean
	isCapped: boolean
	fetchNextPage: () => void
	waiting: boolean
	wrap: boolean
	density: LogsDensity
	pinnedColumns: string[]
	/** Body search text, marked in every message and named in the count line. */
	searchText?: string
	/** Trace the stream is scoped to, named in the count line and the empty state. */
	traceId?: string
	/** Clears both from the empty state. Omitted where neither is set. */
	onClearSearch?: () => void
	onLogClick?: (log: Log) => void
	embedded?: boolean
	/** Flattened active exclusions, for the empty state's hint. Optional: embedded log lists
	 *  (a trace's spans, a session) carry no facet filters. */
	excludedValues?: ReadonlyArray<string>
	clearExclusions?: () => void
	/** Any facet filter is narrowing the stream. */
	filtered?: boolean
	onClearFilters?: () => void
	/** Absent when the range is already wide or custom. */
	onWidenRange?: () => void
	/** Fired when the reader starts or stops inspecting; optional, embedded lists have no live tail. */
	onInspectingChange?: (state: LogsInspectState) => void
	streamRef?: React.Ref<LogsStreamHandle>
}

interface LogsTableProps {
	filters?: LogsSearchParams
	/** Hide the /logs route toolbar — required when rendering off the /logs route
	 *  (LogsTableToolbar reads that route's search params and throws elsewhere). */
	embedded?: boolean
	onInspectingChange?: (state: LogsInspectState) => void
	streamRef?: React.Ref<LogsStreamHandle>
}

function LoadingState() {
	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<SkeletonList
				rows={40}
				className="min-h-0 flex-1 gap-0 overflow-hidden rounded-md border"
				// ROW_HEIGHT (compact): a shorter placeholder row makes the list jump on load.
				renderRow={() => (
					<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
						<Skeleton className="size-1.5 shrink-0 rounded-full" />
						<Skeleton className="h-3 w-16 shrink-0" />
						<Skeleton className="h-3 w-[72px] shrink-0" />
						<Skeleton className="h-3 flex-1" />
					</div>
				)}
			/>
		</div>
	)
}

interface LogRowProps {
	log: Log
	index: number
	top: number
	timeZone: string
	isSelected: boolean
	isFocused: boolean
	isExpanded: boolean
	wrap: boolean
	density: LogsDensity
	pinnedColumns: string[]
	/** Text to mark in the message. Only a text search highlights; an id lookup
	 *  matches the id columns, not the body. */
	highlight?: string
	measureRef?: (node: Element | null) => void
	onClick: (log: Log) => void
	onToggleExpand: (index: number) => void
}

/** `HH:MM:SS` at full strength, the milliseconds a step back: the eye reads seconds first. */
function LogTime({ timestamp, timeZone }: { timestamp: string; timeZone: string }) {
	const formatted = formatCompactTimeInTimezone(timestamp, { timeZone })
	const dot = formatted.lastIndexOf(".")
	if (dot === -1) return formatted
	return (
		<>
			{formatted.slice(0, dot)}
			<span className="text-muted-foreground/50">{formatted.slice(dot)}</span>
		</>
	)
}

const LogRow = React.memo(function LogRow({
	log,
	index,
	top,
	timeZone,
	isSelected,
	isFocused,
	isExpanded,
	wrap,
	density,
	pinnedColumns,
	highlight,
	measureRef,
	onClick,
	onToggleExpand,
}: LogRowProps) {
	// Only chips that add to the message: resource attributes (region, env, pod)
	// repeat down the whole stream, and a value the body already spells out
	// (`503`, the exception message) is said twice. Both wait in the expansion.
	const chips = React.useMemo(() => {
		const pinned = new Set(pinnedColumns)
		return pickImportantAttributes(log, Number.POSITIVE_INFINITY)
			.filter(
				(attr) =>
					attr.source === "log" &&
					!pinned.has(attr.key) &&
					!(attr.value.length >= 3 && log.body.includes(attr.value)),
			)
			.slice(0, MAX_INLINE_CHIPS)
	}, [log, pinnedColumns])
	const { first, hidden } = React.useMemo(() => splitFirstLine(log.body), [log.body])
	const severity = log.severityText.toUpperCase()
	const severityColor = getSeverityColor(log.severityText)
	const { copy } = useCopy({ successMessage: "Copied log message" })

	return (
		<div
			ref={measureRef}
			data-index={index}
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				transform: `translateY(${top}px)`,
			}}
			className="border-b border-border/70"
		>
			<div
				data-selected={isSelected || undefined}
				data-focused={isFocused || undefined}
				data-expanded={isExpanded || undefined}
				tabIndex={0}
				role="listitem"
				onClick={() => onClick(log)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						onClick(log)
					}
				}}
				className={cn(
					"group/row relative flex w-full gap-3 pl-3 pr-3 text-xs font-mono cursor-pointer",
					"before:absolute before:inset-y-0 before:left-0 before:w-0.5",
					"hover:bg-muted/50 data-[selected]:bg-primary/5 data-[expanded]:bg-muted/40 data-[focused]:bg-muted/70 data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
					SEVERITY_ROW.get(severity),
					wrap ? "items-start" : "items-center",
					density === "comfortable" ? "py-3" : "py-[7px]",
				)}
			>
				<button
					type="button"
					aria-label={isExpanded ? "Collapse log" : "Expand log"}
					aria-expanded={isExpanded}
					onClick={(e) => {
						e.stopPropagation()
						onToggleExpand(index)
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") e.stopPropagation()
					}}
					className="-mr-1.5 shrink-0 flex h-4 items-center justify-center w-4 text-muted-foreground/40 group-hover/row:text-muted-foreground hover:text-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:text-foreground"
				>
					<ChevronRightIcon
						size={12}
						className={cn("transition-transform", isExpanded && "rotate-90")}
					/>
				</button>
				<span className="shrink-0 w-[92px] text-foreground/75 tabular-nums">
					<LogTime timestamp={log.timestamp} timeZone={timeZone} />
				</span>
				<span
					className="shrink-0 w-11 text-3xs leading-4 uppercase tabular-nums font-semibold tracking-wide"
					style={{ color: severityColor }}
				>
					{log.severityText}
				</span>
				<span className="shrink-0 w-[128px] hidden md:flex h-4 items-center gap-1.5 min-w-0 text-muted-foreground">
					<ServiceDot serviceName={log.serviceName} size="sm" />
					<span className="truncate">{log.serviceName}</span>
				</span>
				{pinnedColumns.map((key) => {
					const value = log.logAttributes[key] ?? log.resourceAttributes[key] ?? EMPTY_VALUE
					const numeric =
						value !== EMPTY_VALUE && value.trim() !== "" && !Number.isNaN(Number(value))
					return (
						<span
							key={key}
							title={`${key}=${value}`}
							style={{ width: PINNED_COL_WIDTH }}
							className={cn(
								"shrink-0 truncate text-foreground/80 hidden md:block",
								value === EMPTY_VALUE && "text-muted-foreground/40",
								numeric && "tabular-nums",
							)}
						>
							{value}
						</span>
					)
				})}
				<span className={cn("min-w-0 flex-1 flex gap-2", wrap ? "items-start" : "items-center")}>
					{/* The message keeps at least 60% of the lane; chips clip after it. */}
					<span
						className={cn(
							"min-w-[60%]",
							QUIET_SEVERITIES.has(severity) ? "text-muted-foreground" : "text-foreground",
							wrap ? "whitespace-pre-wrap break-words" : "truncate",
						)}
					>
						<HighlightedText text={wrap ? log.body : first} query={highlight} />
					</span>
					{!wrap && hidden > 0 && (
						<span className="shrink-0 rounded border border-border/70 px-1 text-3xs leading-4 text-muted-foreground">
							+{hidden} {hidden === 1 ? "line" : "lines"}
						</span>
					)}
					{chips.length > 0 && (
						// A chip that does not fit wraps onto a hidden second line, so chips
						// drop out whole instead of clipping mid-word; a narrow stream shows none.
						<span className="ml-auto hidden h-[18px] min-w-0 flex-wrap justify-end gap-1 overflow-hidden pl-2 @3xl/log:flex">
							{chips.map((chip) => (
								<LogAttributeChip
									key={chip.key}
									attrKey={chip.key}
									value={chip.value}
									tone={chip.tone}
									className="max-w-full"
								/>
							))}
						</span>
					)}
				</span>
				{/* Row actions, shown on hover or keyboard focus. A wide stream reserves
				    their slot so they never cover a chip; a narrow one (no chips) overlays. */}
				<span
					className={cn(
						"absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-background p-0.5 group-hover/row:flex group-data-[focused]/row:flex",
						"@3xl/log:static @3xl/log:flex @3xl/log:shrink-0 @3xl/log:translate-y-0 @3xl/log:-my-1 @3xl/log:invisible @3xl/log:group-hover/row:visible @3xl/log:group-data-[focused]/row:visible",
					)}
				>
					<RowAction
						label="Copy message"
						onClick={(e) => {
							e.stopPropagation()
							void copy(log.body)
						}}
					>
						<CopyIcon size={13} />
					</RowAction>
					{log.traceId && (
						<Link
							to="/traces/$traceId"
							params={{ traceId: log.traceId }}
							onClick={(e) => e.stopPropagation()}
							aria-label="Open trace"
							title="Open trace"
							className={ROW_ACTION_CLASS}
						>
							<PulseIcon size={13} />
						</Link>
					)}
					<RowAction
						label="Open details"
						onClick={(e) => {
							e.stopPropagation()
							onClick(log)
						}}
					>
						<ExternalLinkIcon size={12} />
					</RowAction>
				</span>
			</div>
			{isExpanded && (
				<LogRowExpanded log={log} highlight={highlight} onOpenDetail={() => onClick(log)} />
			)}
		</div>
	)
})

const ROW_ACTION_CLASS =
	"inline-flex size-5 items-center justify-center rounded text-3xs text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function RowAction({
	label,
	onClick,
	children,
}: {
	label: string
	onClick: (e: React.MouseEvent) => void
	children: React.ReactNode
}) {
	return (
		<button type="button" aria-label={label} title={label} onClick={onClick} className={ROW_ACTION_CLASS}>
			{children}
		</button>
	)
}

/** Sticky column labels, always shown: a dense stream without them reads as a wall of text. */
function ColumnHeader({ pinnedColumns, timeZone }: { pinnedColumns: string[]; timeZone: string }) {
	return (
		<Eyebrow
			as="div"
			className="sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 bg-background border-b border-border select-none"
		>
			<span className="-mr-1.5 shrink-0 w-4" aria-hidden="true" />
			<span className="shrink-0 w-[92px]" title={`Times in ${timeZone}`}>
				Time
			</span>
			<span className="shrink-0 w-11">Level</span>
			<span className="shrink-0 w-[128px] hidden md:inline-block">Service</span>
			{pinnedColumns.map((key) => (
				<span
					key={key}
					title={key}
					style={{ width: PINNED_COL_WIDTH }}
					className="shrink-0 truncate text-foreground/60 hidden md:block"
				>
					{key}
				</span>
			))}
			<span className="min-w-0 flex-1">Message</span>
		</Eyebrow>
	)
}

export function LogsTableView({
	allData,
	isFetchingNextPage,
	hasNextPage,
	isCapped,
	fetchNextPage,
	waiting,
	wrap,
	density,
	pinnedColumns,
	searchText,
	traceId,
	onClearSearch,
	onLogClick,
	embedded,
	excludedValues = EMPTY_EXCLUDED,
	clearExclusions,
	filtered = excludedValues.length > 0,
	onClearFilters,
	onWidenRange,
	onInspectingChange,
	streamRef,
}: LogsTableViewProps) {
	const [selectedLog, setSelectedLog] = React.useState<Log | null>(null)
	const [sheetOpen, setSheetOpen] = React.useState(false)
	// Rows are index-keyed, so expansion belongs to the data it was made on: a
	// refresh that prepends rows would otherwise point it at different logs.
	const [expansion, setExpansion] = React.useState(() => ({
		anchor: allData.at(0),
		rows: NO_EXPANDED_ROWS,
	}))
	if (expansion.anchor !== allData.at(0)) {
		setExpansion({ anchor: allData.at(0), rows: NO_EXPANDED_ROWS })
	}
	const expandedRows = expansion.rows
	const { effectiveTimezone } = useTimezonePreference()
	const scrollContainerRef = React.useRef<HTMLDivElement>(null)
	// This pane owns its scroller (the route mounts it under `DashboardLayout.Fill`,
	// not `.Scroll`), so it has to raise the sticky area's shadow itself.
	const reportScrolled = usePageScrolledReporter()

	// Inspect bookkeeping, written only from event handlers. Each cause is tracked
	// apart so the page hears one change per transition, not one per scroll frame.
	const inspectInputsRef = React.useRef(NO_INSPECT_INPUTS)
	const reportedInspectRef = React.useRef(NOT_INSPECTING)
	const updateInspect = React.useCallback(
		(patch: Partial<InspectInputs>) => {
			const inputs = { ...inspectInputsRef.current, ...patch }
			inspectInputsRef.current = inputs
			const next: LogsInspectState = {
				inspecting: inputs.hovering || inputs.scrolledAway || inputs.expanded || inputs.detail,
				scrolledAway: inputs.scrolledAway,
			}
			const reported = reportedInspectRef.current
			if (reported.inspecting === next.inspecting && reported.scrolledAway === next.scrolledAway) return
			reportedInspectRef.current = next
			onInspectingChange?.(next)
		},
		[onInspectingChange],
	)

	const handleRowClick = React.useCallback(
		(log: Log) => {
			if (onLogClick) {
				onLogClick(log)
				return
			}
			setSelectedLog(log)
			setSheetOpen(true)
			updateInspect({ detail: true })
		},
		[onLogClick, updateInspect],
	)

	const handleSheetOpenChange = React.useCallback(
		(open: boolean) => {
			setSheetOpen(open)
			if (!open) setSelectedLog(null)
			updateInspect({ detail: open })
		},
		[updateInspect],
	)

	// Measured row heights, feeding an adaptive estimate. The constants below are
	// only a cold start: a compact row actually lands near 31px (an 18px chip
	// between two 6px paddings plus the border), so every measurement used to
	// shrink `getTotalSize()` and drag the scrollbar out from under the cursor.
	// Expanded rows are excluded — they are not representative of the rest.
	const sizeStatsRef = React.useRef({ sum: 0, byIndex: new Map<number, number>() })
	const expandedRowsRef = React.useRef(expandedRows)
	React.useLayoutEffect(() => {
		expandedRowsRef.current = expandedRows
		// New data drops expansion during render, where the page cannot be told;
		// release the hold here so a reload or new query never leaves it stuck.
		if (expandedRows.size === 0 && inspectInputsRef.current.expanded) updateInspect({ expanded: false })
	}, [expandedRows, updateInspect])

	// The empty state has no stream to hover, scroll or open, so it can never fire
	// the events that release those holds; drop them when the list empties.
	React.useLayoutEffect(() => {
		if (allData.length > 0) return
		const { hovering, scrolledAway, detail } = inspectInputsRef.current
		if (hovering || scrolledAway || detail)
			updateInspect({ hovering: false, scrolledAway: false, detail: false })
	}, [allData.length, updateInspect])

	// Reads the committed set from the ref (user events land after layout effects),
	// which keeps this stable for the memoized rows.
	const setRowExpanded = React.useCallback(
		(index: number, expand: boolean | "toggle") => {
			const current = expandedRowsRef.current
			const on = expand === "toggle" ? !current.has(index) : expand
			if (on === current.has(index)) return
			const rows = new Set(current)
			if (on) rows.add(index)
			else rows.delete(index)
			expandedRowsRef.current = rows
			setExpansion((prev) => ({ anchor: prev.anchor, rows }))
			updateInspect({ expanded: rows.size > 0 })
		},
		[updateInspect],
	)
	const toggleExpanded = React.useCallback(
		(index: number) => setRowExpanded(index, "toggle"),
		[setRowExpanded],
	)

	const collapseAll = () => {
		expandedRowsRef.current = NO_EXPANDED_ROWS
		setExpansion((prev) =>
			prev.rows.size === 0 ? prev : { anchor: prev.anchor, rows: NO_EXPANDED_ROWS },
		)
		updateInspect({ expanded: false })
	}

	const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
		const away = event.currentTarget.scrollTop > 0
		reportScrolled(away)
		if (away !== inspectInputsRef.current.scrolledAway) updateInspect({ scrolledAway: away })
	}

	React.useImperativeHandle(streamRef, () => ({
		jumpToLatest: () => {
			scrollContainerRef.current?.scrollTo({ top: 0 })
			reportScrolled(false)
			collapseAll()
			updateInspect({ scrolledAway: false })
		},
	}))

	// The stream can unmount mid-inspection (a loading or error state replaces it);
	// release any hold it was keeping on the page.
	const onUnmount = React.useEffectEvent(() => {
		if (reportedInspectRef.current.inspecting) onInspectingChange?.(NOT_INSPECTING)
	})
	// react-doctor-disable-next-line react-doctor/rules-of-hooks -- React Doctor does not recognize useMountEffect as an Effect Event boundary.
	useMountEffect(() => () => onUnmount())

	const estimateSize = React.useCallback(() => {
		const stats = sizeStatsRef.current
		if (stats.byIndex.size >= 8) return Math.round(stats.sum / stats.byIndex.size)
		if (wrap) return density === "comfortable" ? 88 : 72
		return density === "comfortable" ? ROW_HEIGHT_COMFORTABLE : ROW_HEIGHT
	}, [wrap, density])

	const virtualizer = useVirtualizer({
		count: allData.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize,
		// 4 rows of buffer is ~140px at compact density — a flick outruns it and
		// leaves blank bands, which reads as the list stuttering.
		overscan: wrap ? 6 : 12,
	})

	// Every row is measured, not just the wrapped/expanded ones: an unmeasured
	// row keeps its estimate, and a list of wrong estimates is exactly the drift
	// above. Recording the height here (rather than reading the virtualizer's
	// cache) keeps the mean deduped by index.
	const measureElement = React.useCallback(
		(node: Element | null) => {
			virtualizer.measureElement(node)
			if (!(node instanceof HTMLElement)) return
			const index = Number(node.dataset.index)
			if (!Number.isInteger(index) || expandedRowsRef.current.has(index)) return
			const height = node.offsetHeight
			if (height <= 0) return
			const stats = sizeStatsRef.current
			const previous = stats.byIndex.get(index)
			if (previous === height) return
			stats.sum += height - (previous ?? 0)
			stats.byIndex.set(index, height)
		},
		[virtualizer],
	)

	// A global wrap/density change resizes every row at once. Clear the
	// measurement cache so off-screen rows re-measure from the corrected
	// estimate instead of jumping on the stale one. Per-row expand/collapse
	// re-measures automatically via the row's ResizeObserver. Mounted rows are
	// re-measured by hand: one whose height did not change fires no resize, and
	// would otherwise keep the (now wrong) estimate as its slot.
	React.useLayoutEffect(() => {
		sizeStatsRef.current = { sum: 0, byIndex: new Map() }
		virtualizer.measure()
		scrollContainerRef.current?.querySelectorAll("[role='log'] > [data-index]").forEach(measureElement)
	}, [wrap, density, virtualizer, measureElement])

	const virtualItems = virtualizer.getVirtualItems()

	const scopeSuffix = [
		traceId ? ` in trace ${shortId(traceId, "trace")}` : "",
		searchText ? ` matching “${searchText}”` : "",
	].join("")

	// Index-keyed nav ids: logs have no stable row id, and the list is
	// append-only for a given query, so indices stay stable while browsing.
	const rowIds = React.useMemo(() => allData.map((_, index) => String(index)), [allData])
	const { focusedId } = useListNavigation({
		ids: rowIds,
		enabled: allData.length > 0,
		onOpen: (id) => {
			const log = allData[Number(id)]
			if (log) handleRowClick(log)
		},
		scrollTo: (_id, index) => virtualizer.scrollToIndex(index, { align: "auto" }),
	})
	const focusedIndex = focusedId === null ? -1 : Number(focusedId)

	// →/← expand or collapse the focused row, complementing the chevron.
	useHotkeys(
		[
			{
				hotkey: "ArrowRight",
				callback: () => {
					if (isDialogOpen() || focusedIndex < 0) return
					setRowExpanded(focusedIndex, true)
				},
				options: { ignoreInputs: true },
			},
			{
				hotkey: "ArrowLeft",
				callback: () => {
					if (isDialogOpen() || focusedIndex < 0) return
					setRowExpanded(focusedIndex, false)
				},
				options: { ignoreInputs: true },
			},
		],
		{ enabled: allData.length > 0 },
	)

	useVirtualReachEnd(virtualizer, {
		count: allData.length,
		hasMore: hasNextPage,
		loading: isFetchingNextPage,
		onReachEnd: fetchNextPage,
		threshold: FETCH_THRESHOLD,
	})

	if (allData.length === 0) {
		return (
			<div className="flex-1 min-h-0 flex flex-col gap-4">
				{!onLogClick && !embedded && <LogsTableToolbar />}
				{/* A search term or a trace scope explains the emptiness better than anything
				    presence can add — the user asked a narrow question and it had no answer. */}
				{searchText || traceId ? (
					<div className="flex h-48 flex-col items-center justify-center gap-2 rounded-md border px-6 text-center">
						<span className="text-sm text-muted-foreground">
							{traceId ? (
								<>
									No logs on trace{" "}
									<span className="font-mono text-foreground">{traceId}</span> in this time
									range
								</>
							) : (
								<>
									No log message contains{" "}
									<span className="font-mono text-foreground">“{searchText}”</span>
								</>
							)}
						</span>
						{traceId && (
							<span className="flex max-w-md flex-col items-center gap-2 text-xs text-muted-foreground">
								Logs link to a trace when your logger bridge runs inside the active span.
								<DocsLink page="logs" />
							</span>
						)}
						{onClearSearch && (
							<button
								type="button"
								onClick={onClearSearch}
								className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline"
							>
								Clear search
							</button>
						)}
						{clearExclusions && (
							<ExcludedEmptyHint
								excluded={excludedValues}
								onClear={clearExclusions}
								className="max-w-lg"
							/>
						)}
					</div>
				) : (
					<div className="rounded-md border">
						<SignalEmptyState
							signal="logs"
							filtered={filtered}
							onClearFilters={onClearFilters}
							onWidenRange={onWidenRange}
							detail={
								clearExclusions && (
									<ExcludedEmptyHint
										excluded={excludedValues}
										onClear={clearExclusions}
										className="max-w-lg"
									/>
								)
							}
						/>
					</div>
				)}
			</div>
		)
	}

	return (
		<>
			<div
				className={cn("flex min-h-0 flex-1 flex-col", refreshingClass(waiting))}
				aria-busy={waiting || undefined}
			>
				{!onLogClick && !embedded && <LogsTableToolbar />}
				<div
					className="flex-1 min-h-0 relative"
					onPointerEnter={() => updateInspect({ hovering: true })}
					onPointerLeave={() => updateInspect({ hovering: false })}
				>
					<div
						ref={scrollContainerRef}
						onScroll={handleScroll}
						className="@container/log absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain rounded-md border"
					>
						<ColumnHeader pinnedColumns={pinnedColumns} timeZone={effectiveTimezone} />
						<div
							style={{
								height: virtualizer.getTotalSize(),
								position: "relative",
							}}
							role="log"
						>
							{virtualItems.map((virtualRow) => {
								const log = allData[virtualRow.index]
								const isSelected = selectedLog === log
								const isExpanded = expandedRows.has(virtualRow.index)
								return (
									<LogRow
										key={virtualRow.index}
										log={log}
										index={virtualRow.index}
										top={virtualRow.start}
										timeZone={effectiveTimezone}
										isSelected={isSelected}
										isFocused={virtualRow.index === focusedIndex}
										isExpanded={isExpanded}
										wrap={wrap}
										density={density}
										pinnedColumns={pinnedColumns}
										highlight={searchText}
										measureRef={measureElement}
										onClick={handleRowClick}
										onToggleExpand={toggleExpanded}
									/>
								)
							})}
						</div>
					</div>
					<div className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none rounded-b-md bg-gradient-to-t from-background to-transparent" />
				</div>

				<ListFooter
					shown={allData.length}
					noun={`logs${scopeSuffix}`}
					capped={isCapped}
					hasMore={hasNextPage}
					align="start"
					className="mt-1.5 shrink-0 p-0"
				/>
			</div>

			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={handleSheetOpenChange} />
		</>
	)
}

/** Stable identity for the default, so the view never sees a new array each render. */
const EMPTY_EXCLUDED: ReadonlyArray<string> = []

export function LogsTable({ filters, embedded, onInspectingChange, streamRef }: LogsTableProps) {
	const { firstPageResult, allData, isFetchingNextPage, hasNextPage, isCapped, fetchNextPage } =
		useInfiniteLogs(filters)
	// Bound to the logs route so clearing exclusions keeps the rest of the search params typed.
	const navigateLogs = useNavigate({ from: "/logs/" })

	// An empty list under an exclusion cannot explain itself — see `ExcludedEmptyHint`.
	const excludedChips = logFilterChips(filters ?? {}).filter((chip) => chip.negated)
	const excludedValues = excludedChips.flatMap((chip) => chip.values)
	const clearExclusions = () =>
		navigateLogs({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(excludedChips.map((chip) => [chip.param, undefined])),
			}),
		})
	const filterChips = logFilterChips(filters ?? {})
	const clearFilters = () =>
		navigateLogs({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(filterChips.map((chip) => [chip.param, undefined])),
			}),
		})
	const canWiden = !embedded && canWidenTimeRange(filters ?? {}, "")
	const widenRange = () =>
		navigateLogs({ search: (prev) => applyTimeRangeSearch(prev, { presetValue: WIDEN_TIME_PRESET }) })
	const { wrap, density } = useLogsViewPreferences()

	const columnsKey = (filters?.columns ?? EMPTY_COLUMNS).join("\x00")
	const pinnedColumns = React.useMemo(
		() => filters?.columns ?? EMPTY_COLUMNS,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[columnsKey],
	)

	return Result.builder(firstPageResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <ErrorState error={error} />)
		.onSuccess((_response, result) => (
			<LogsTableView
				allData={allData}
				isFetchingNextPage={isFetchingNextPage}
				hasNextPage={hasNextPage}
				isCapped={isCapped}
				fetchNextPage={fetchNextPage}
				waiting={result.waiting ?? false}
				wrap={wrap}
				density={density}
				pinnedColumns={pinnedColumns}
				searchText={filters?.search}
				traceId={filters?.traceId}
				onClearSearch={
					filters?.search || filters?.traceId
						? () =>
								navigateLogs({
									search: (prev) => ({ ...prev, search: undefined, traceId: undefined }),
								})
						: undefined
				}
				embedded={embedded}
				excludedValues={excludedValues}
				clearExclusions={clearExclusions}
				filtered={filterChips.length > 0}
				onClearFilters={embedded ? undefined : clearFilters}
				onWidenRange={canWiden ? widenRange : undefined}
				onInspectingChange={onInspectingChange}
				streamRef={streamRef}
			/>
		))
		.render()
}

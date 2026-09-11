import { useCallback, useMemo, type ReactNode } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
	columnSizingFeature,
	type ColumnDef,
	flexRender,
	tableFeatures,
	useTable,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { AiSessionSortDir, AiSessionSortKey } from "@maple/domain/http"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { TableSkeleton } from "@maple/ui/components/ui/table-skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatCount } from "@maple/ui/components/filters/range-filter-section"
import { cn } from "@maple/ui/lib/utils"
import {
	FaceRobotIcon,
	GearIcon,
	PixelSparkleIcon,
	SquareSparkleIcon,
	type IconComponent,
} from "@/components/icons"
import { ServicePills } from "@/components/common/service-pills"
import { SortableHeader } from "@/components/common/sortable-header"
import { useDetectedModels } from "@/hooks/use-detected-models"
import { usePageScrollMargin } from "@/hooks/use-page-scroll-margin"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { sessionLinkWindow, sessionRowIdParts } from "@/lib/agent-sessions/session-window"
import { TOKEN_BUCKETS, type TokenBucketKey } from "@/lib/agent-sessions/token-buckets"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { ModelLabel, modelTitle } from "./model-label"
import { sessionIdentity } from "./session-detail/session-header"
import { CATEGORY_TEXT } from "./session-detail/span-visuals"

/** The wire row from `listAiSessions` — one AI agent session, newest first. */
export interface AgentSessionRow {
	readonly sessionId: string
	readonly vendorId: string
	/** The framework's own version, as it stamped it. `''`/absent where it did
	 *  not — the tool detail's session list names it beside the framework. */
	readonly vendorVersion?: string
	readonly traceCount: number
	readonly spanCount: number
	readonly errorSpanCount: number
	/** Failed tool calls, one per failure rather than per span that echoed it. */
	readonly toolErrorCount: number
	/** Failed model calls and turn spans that failed on their own. */
	readonly turnErrorCount: number
	readonly serviceNames: ReadonlyArray<string>
	readonly models: ReadonlyArray<string>
	readonly agentNames: ReadonlyArray<string>
	/** The agent on the session's earliest-starting named span; `""` when none
	 *  did. `agentNames` is an unordered set, so it cannot name the row. */
	readonly firstAgentName: string
	readonly llmCalls: number
	readonly toolCalls: number
	readonly totalTokens: number
	readonly inputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	readonly cost: number
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
	/** Set once the row's details landed — its bounds are then the true extent. */
	readonly hasDetails?: boolean
}

function absoluteTs(startTime: string, timeZone: string): string {
	const parsed = toEpochMs(startTime)
	return Number.isNaN(parsed) ? startTime : formatTimestampInTimezone(parsed, { timeZone, withYear: true })
}

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`

/** The row's buckets under the detail page's keys, so one palette serves both. */
function rowTokenBuckets(session: AgentSessionRow): Record<TokenBucketKey, number> {
	return {
		input: session.inputTokens,
		cacheRead: session.cacheReadTokens,
		cacheWrite: session.cacheWriteTokens,
		output: session.outputTokens,
		reasoning: session.reasoningTokens,
	}
}

/**
 * v9 registers features explicitly. Sorting is server-side and nothing else here is table-driven,
 * so column sizing — the declared widths the header cells read back — is the only one needed.
 */
const TABLE_FEATURES = tableFeatures({ columnSizingFeature })

/** Two lines — the name over the id — at text-sm and text-xs, plus the cell padding. */
const ROW_HEIGHT = 53

// No wrap: a two-word label ("LLM calls") breaking onto a second line would
// make the whole header row taller.
const HEADER_CELL_CLASS = "h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-muted-foreground"

/**
 * Column layout, shared by the real table and the loading skeleton so the two can't drift apart.
 *
 * `responsive` drops a column when the table gets too narrow to hold it, protecting Session — the
 * only column that identifies the row, and the only one that flexes. Thresholds are *container*
 * queries against `@container/page` (declared by PageLayout.Content), as on the traces table: the
 * app sidebar and the filter rail take width the viewport knows nothing about.
 *
 * Budget: Errors (100) is always on — the triage signal, as Status is for traces. Every other column
 * joins where Session keeps ≥200px beside it, the sortable measures first, so a width that shows a
 * measure can also sort by it: Started (96) at 400, Duration (100) at 500, Cost (80) at 580, LLM
 * calls (110) at 690, Tool calls (116) at 810 and Tokens (130) at 940. Services (170) at 1110 and
 * Model (160) at 1270 come last — the filter rail answers both for the whole list. A sortable
 * column is at least as wide as its label and arrow at text-sm plus the cell's padding.
 */
interface SessionColumnLayout {
	readonly id: string
	readonly header: string
	readonly skeleton: string
	readonly width?: number
	/** Applied to both the th and the td — keep it a literal so Tailwind's scanner sees it. */
	readonly responsive?: string
}

const SESSION_COLUMNS: readonly SessionColumnLayout[] = [
	// No width: under table-fixed the unsized column absorbs whatever the sized ones leave.
	{ id: "session", header: "Session", skeleton: "w-40" },
	{
		id: "services",
		header: "Services",
		width: 170,
		skeleton: "w-24",
		responsive: "hidden @min-[1110px]/page:table-cell",
	},
	{
		id: "model",
		header: "Model",
		width: 160,
		skeleton: "w-24",
		responsive: "hidden @min-[1270px]/page:table-cell",
	},
	{
		id: "durationMs",
		header: "Duration",
		width: 100,
		skeleton: "w-12",
		responsive: "hidden @min-[500px]/page:table-cell",
	},
	{
		id: "llmCalls",
		header: "LLM calls",
		width: 110,
		skeleton: "w-8",
		responsive: "hidden @min-[690px]/page:table-cell",
	},
	{
		id: "toolCalls",
		header: "Tool calls",
		width: 116,
		skeleton: "w-8",
		responsive: "hidden @min-[810px]/page:table-cell",
	},
	{
		id: "totalTokens",
		header: "Tokens",
		width: 130,
		skeleton: "w-20",
		responsive: "hidden @min-[940px]/page:table-cell",
	},
	{
		id: "cost",
		header: "Cost",
		width: 80,
		skeleton: "w-10",
		responsive: "hidden @min-[580px]/page:table-cell",
	},
	{ id: "errorSpanCount", header: "Errors", width: 100, skeleton: "w-12" },
	{
		id: "startTime",
		header: "Started",
		width: 96,
		skeleton: "w-14",
		responsive: "hidden @min-[400px]/page:table-cell",
	},
]

const COLUMN_LAYOUT: ReadonlyMap<string, SessionColumnLayout> = new Map(
	SESSION_COLUMNS.map((column) => [column.id, column]),
)

interface AgentSessionsListProps {
	sessions: ReadonlyArray<AgentSessionRow>
	/** The order the server returned the rows in — the header it names is marked. */
	sortBy: AiSessionSortKey
	sortDir: AiSessionSortDir
	onSortChange: (key: AiSessionSortKey) => void
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	/** Whether more pages remain (renders the sentinel + footer). */
	hasMore?: boolean
	/** Whether a next page is currently in flight. */
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
}

function observeReachEnd(element: HTMLDivElement, onReachEnd: () => void): () => void {
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0]?.isIntersecting) onReachEnd()
		},
		{ rootMargin: "400px 0px" },
	)
	observer.observe(element)
	return () => observer.disconnect()
}

function SessionsSentinel({
	onReachEnd,
	loadingMore,
}: Pick<AgentSessionsListProps, "onReachEnd" | "loadingMore">) {
	const elementRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return
			return observeReachEnd(element, () => {
				if (!loadingMore) onReachEnd?.()
			})
		},
		[loadingMore, onReachEnd],
	)

	return <div ref={elementRef} aria-hidden className="h-px w-full" />
}

export function AgentSessionsListSkeleton() {
	return (
		<TableSkeleton
			rows={10}
			tableClassName="w-full table-fixed"
			columns={SESSION_COLUMNS.map((column) => ({
				header: column.header,
				headClassName: column.responsive,
				cellClassName: column.responsive,
				skeleton: column.skeleton,
				width: column.width,
			}))}
		/>
	)
}

export function AgentSessionsList({
	sessions,
	sortBy,
	sortDir,
	onSortChange,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
}: AgentSessionsListProps) {
	const navigate = useNavigate()
	const { effectiveTimezone } = useTimezonePreference()
	// One batch for the whole page, re-asked only when paging brings a model
	// the list has not seen. Before it lands every row still names its model.
	const detect = useDetectedModels(sessions.flatMap((session) => session.models))

	const columns = useMemo<ColumnDef<typeof TABLE_FEATURES, AgentSessionRow>[]>(() => {
		const sortHeader = (label: string, sortKey: AiSessionSortKey, hint?: string) => () => (
			<SortableHeader
				label={label}
				sortKey={sortKey}
				activeKey={sortBy}
				dir={sortDir}
				onSort={onSortChange}
				hint={hint}
			/>
		)
		return [
			{
				id: "session",
				header: "Session",
				cell: ({ row }) => <SessionCell session={row.original} timeZone={effectiveTimezone} />,
			},
			{
				id: "services",
				header: "Services",
				size: 170,
				cell: ({ row }) => <ServicePills services={row.original.serviceNames} />,
			},
			{
				id: "model",
				header: "Model",
				size: 160,
				cell: ({ row }) => {
					const { models } = row.original
					const [firstModel] = models
					// The first model by name and mark, the rest as a count; the raw ids
					// gateways report go in the tooltip, where two models that truncate
					// alike are still told apart.
					return firstModel === undefined ? null : (
						<Hint
							className="block min-w-0 text-xs text-muted-foreground"
							content={
								<div className="flex flex-col gap-0.5">
									{models.map((model) => (
										<span key={model}>{modelTitle(detect(model))}</span>
									))}
								</div>
							}
						>
							<ModelLabel detected={detect(firstModel)} moreCount={models.length - 1} title={null} />
						</Hint>
					)
				},
			},
			{
				id: "durationMs",
				header: sortHeader("Duration", "durationMs", "From the first agent span to the last"),
				size: 100,
				// Traces and spans live in the tooltip — they describe ingestion, the
				// calls and tools beside them describe the agent.
				cell: ({ row }) => (
					<Hint
						className="font-mono text-xs tabular-nums"
						content={`Across ${plural(row.original.traceCount, "trace")} · ${plural(row.original.spanCount, "span")}`}
					>
						{formatSessionDuration(row.original.durationMs)}
					</Hint>
				),
			},
			{
				id: "llmCalls",
				header: sortHeader("LLM calls", "llmCalls", "Model requests the agent made"),
				size: 110,
				cell: ({ row }) => (
					<WorkCount
						icon={PixelSparkleIcon}
						tone={CATEGORY_TEXT.inference}
						count={row.original.llmCalls}
						noun="LLM call"
					/>
				),
			},
			{
				id: "toolCalls",
				header: sortHeader("Tool calls", "toolCalls", "Tools the agent invoked"),
				size: 116,
				cell: ({ row }) => (
					<WorkCount
						icon={GearIcon}
						tone={CATEGORY_TEXT.tool}
						count={row.original.toolCalls}
						noun="tool call"
					/>
				),
			},
			{
				id: "totalTokens",
				header: sortHeader("Tokens", "totalTokens", "Reported by the session's model calls"),
				size: 130,
				cell: ({ row }) => <TokenBar session={row.original} />,
			},
			{
				id: "cost",
				header: sortHeader("Cost", "cost", "As priced by the instrumentation; blank where it reported none"),
				size: 80,
				// Blank where nothing was reported — a "$0.00" would read as "measured,
				// and it was free".
				cell: ({ row }) =>
					row.original.cost > 0 ? (
						<Hint className="font-mono text-xs tabular-nums" content="As priced by the instrumentation">
							{formatCost(row.original.cost)}
						</Hint>
					) : null,
			},
			{
				id: "errorSpanCount",
				header: sortHeader("Errors", "errorSpanCount", "Failed turns and tool calls"),
				size: 100,
				cell: ({ row }) => <ErrorChips session={row.original} />,
			},
			{
				id: "startTime",
				header: sortHeader("Started", "startTime"),
				size: 96,
				cell: ({ row }) => (
					<StartedAt
						startTime={row.original.startTime}
						timeZone={effectiveTimezone}
						className="block truncate text-xs text-muted-foreground"
					/>
				),
			},
		]
	}, [effectiveTimezone, detect, sortBy, sortDir, onSortChange])

	const table = useTable({ features: TABLE_FEATURES, data: sessions, columns })
	const { rows } = table.getRowModel()

	// Rows ride the page's own scroller, as on /replays, rather than an inner
	// one: the sentinel below the table then still marks the end of the list.
	// So the table must sit inside a `PageLayout.ScrollArea`. Outside one the
	// hook falls back to the tbody itself, which has no height until it has
	// rows and gets no rows until it has height.
	const { ref: listRef, getScrollElement, scrollMargin } = usePageScrollMargin()
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10,
		scrollMargin,
	})
	const virtualItems = virtualizer.getVirtualItems()

	if (sessions.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<SquareSparkleIcon />
					</EmptyMedia>
					<EmptyTitle>No agent sessions yet</EmptyTitle>
					<EmptyDescription>
						Trace your AI agents with a supported framework, or emit OpenTelemetry{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">gen_ai</code>{" "}
						spans, and their sessions will show up here. A framework that groups its turns with a{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
							maple_ai.session.id
						</code>{" "}
						attribute gets one session across every trace; anything else gets one per trace.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	const firstItem = virtualItems[0]
	const lastItem = virtualItems[virtualItems.length - 1]

	return (
		<div>
			<div className="rounded-md border">
				{/*
				 * table-fixed makes the declared column widths authoritative: the sized columns stay
				 * pinned and Session, the only column that should flex, takes the remainder.
				 */}
				<table className="w-full table-fixed caption-bottom text-sm" aria-label="Agent sessions">
					<thead className="sticky top-0 z-10 bg-background [&_tr]:border-b">
						{table.getHeaderGroups().map((headerGroup) => (
							<tr key={headerGroup.id}>
								{headerGroup.headers.map((header) => (
									<th
										key={header.id}
										aria-sort={
											header.id === sortBy
												? sortDir === "asc"
													? "ascending"
													: "descending"
												: undefined
										}
										className={cn(HEADER_CELL_CLASS, COLUMN_LAYOUT.get(header.id)?.responsive)}
										style={{
											width: header.getSize() !== 150 ? header.getSize() : undefined,
										}}
									>
										{header.isPlaceholder
											? null
											: flexRender(header.column.columnDef.header, header.getContext())}
									</th>
								))}
							</tr>
						))}
					</thead>
					<tbody ref={listRef}>
						{firstItem && (
							<tr aria-hidden style={{ height: firstItem.start - virtualizer.options.scrollMargin }}>
								<td />
							</tr>
						)}
						{virtualItems.map((virtualRow) => {
							const row = rows[virtualRow.index]!
							const session = row.original
							return (
								<tr
									key={row.id}
									ref={virtualizer.measureElement}
									data-index={virtualRow.index}
									onClick={() =>
										navigate({
											to: "/agent-sessions/$sessionId",
											params: { sessionId: session.sessionId },
											search: sessionLinkWindow(session),
										})
									}
									className="cursor-pointer border-b transition-colors hover:bg-muted/50"
								>
									{row.getAllCells().map((cell) => (
										<td
											key={cell.id}
											className={cn("p-2 align-middle", COLUMN_LAYOUT.get(cell.column.id)?.responsive)}
										>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</td>
									))}
								</tr>
							)
						})}
						{lastItem && (
							<tr
								aria-hidden
								style={{
									height:
										virtualizer.getTotalSize() -
										(lastItem.end - virtualizer.options.scrollMargin),
								}}
							>
								<td />
							</tr>
						)}
						{loadingMore && (
							<tr>
								<td colSpan={SESSION_COLUMNS.length} className="p-2">
									<div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
										<span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
										Loading more sessions…
									</div>
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{hasMore && <SessionsSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing the {sessions.length.toLocaleString()} most recent sessions — filter the list to
					see older ones
				</p>
			)}
		</div>
	)
}

/** An inline figure with a tooltip saying what it counts. */
function Hint({
	content,
	className,
	children,
}: {
	content: ReactNode
	className?: string
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger render={<span />} className={className}>
				{children}
			</TooltipTrigger>
			<TooltipContent>{content}</TooltipContent>
		</Tooltip>
	)
}

function StartedAt({
	startTime,
	timeZone,
	className,
}: {
	startTime: string
	timeZone: string
	className: string
}) {
	return (
		<Hint className={className} content={absoluteTs(startTime, timeZone)}>
			{formatRelativeTimeOrDate(startTime, undefined, timeZone)}
		</Hint>
	)
}

/**
 * What the session IS on the first line — the agent it ran, beside the
 * framework's mark — and what it is CALLED on the second. The id is how you
 * cite a session, not how you recognise one, so it reads as metadata under the
 * name, labelled with the kind of id it is: a framework's session key, or the
 * one trace a framework without session keys produced.
 */
function SessionCell({ session, timeZone }: { session: AgentSessionRow; timeZone: string }) {
	const VendorIcon = vendorIcon(session.vendorId)
	const vendor = vendorLabel(session.vendorId)
	// `sessionIdentity` reads the first name, so it is handed the one name the
	// warehouse resolved in span order rather than the unordered `agentNames`
	// set — see `firstAgentName`.
	const { heading } = sessionIdentity({
		agentNames: session.firstAgentName === "" ? [] : [session.firstAgentName],
		vendorIds: [session.vendorId],
	})
	const id = sessionRowIdParts(session.sessionId)
	return (
		<div className="min-w-0">
			<div className="flex min-w-0 items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={<span />}
						role="img"
						aria-label={vendor}
						className="flex shrink-0 items-center text-muted-foreground"
					>
						<VendorIcon size={15} aria-hidden />
					</TooltipTrigger>
					<TooltipContent>{vendor}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						render={
							<Link
								to="/agent-sessions/$sessionId"
								params={{ sessionId: session.sessionId }}
								// The session's own bounds, not the list's window — its agent spans'
								// extent until the row's details land, the true one after — so the
								// detail page reads straight from these.
								search={sessionLinkWindow(session)}
								// The row navigates on its own; the link is for a new tab and the
								// keyboard, and must not navigate twice.
								onClick={(event) => event.stopPropagation()}
							/>
						}
						className="min-w-0 truncate text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none"
					>
						{heading}
					</TooltipTrigger>
					<TooltipContent>
						{session.agentNames.length > 0
							? `Agents: ${session.agentNames.join(", ")}`
							: "No agent name was reported"}
					</TooltipContent>
				</Tooltip>
				{/* Until the Started column fits, the time anchors the cell's top-right corner. */}
				<StartedAt
					startTime={session.startTime}
					timeZone={timeZone}
					className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @min-[400px]/page:hidden"
				/>
			</div>
			<Tooltip>
				<TooltipTrigger render={<div />} className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs">
					<span className="shrink-0 text-muted-foreground/70">
						{id.kind === "trace" ? "Trace" : "Session"}
					</span>
					<span className="min-w-0 truncate font-mono text-muted-foreground">{id.short}</span>
				</TooltipTrigger>
				<TooltipContent>
					<p>
						{id.kind === "trace"
							? "No session key was reported, so this session is this one trace"
							: "The session ID the framework reported"}
					</p>
					<p className="mt-0.5 break-all font-mono">{id.id}</p>
				</TooltipContent>
			</Tooltip>
		</div>
	)
}

/** A count with the kind's glyph, in its hue — the same pair the session page's
 *  waterfall and flow use for the kind of work. The header names the unit. */
function WorkCount({
	icon: Icon,
	tone,
	count,
	noun,
}: {
	icon: IconComponent
	tone: string
	count: number
	noun: string
}) {
	// Compact: a busy session runs to four and five figures, and the column is
	// sized for its header, not for the widest count it will ever hold.
	return (
		<Hint
			className={cn(
				"inline-flex items-center gap-1 text-xs tabular-nums",
				count > 0 ? tone : "text-muted-foreground",
			)}
			content={plural(count, noun)}
		>
			<Icon size={12} className="shrink-0" aria-hidden />
			{formatCount(count)}
		</Hint>
	)
}

/** The share of the index's total the buckets must reach to be drawn — the
 *  dedupe can leave the two a little apart, never this far. */
const BUCKET_COVERAGE_MIN = 0.9

/**
 * The detail page's Tokens rail at row height: one segment per non-empty
 * bucket, in that rail's fills, so cached against fresh against generated can
 * be compared down the list. The figure beside the bar is the buckets' sum —
 * the number the detail page's header reaches — and falls back to the index's
 * total only for a session that reported no buckets. The two can differ: the
 * index sums the reported figures as stamped, the buckets carve the cache back
 * out of an inclusive prompt figure, and the sort and filter read the index.
 */
function TokenBar({ session }: { session: AgentSessionRow }) {
	const buckets = rowTokenBuckets(session)
	const drawn = TOKEN_BUCKETS.filter((bucket) => buckets[bucket.key] > 0)
	const drawnTotal = drawn.reduce((sum, bucket) => sum + buckets[bucket.key], 0)
	// Buckets well short of the index's total were not reported for every
	// reporter — the index rows written before the buckets were materialized
	// carry zeros, and a session that straddles that cut sums a slice — so the
	// row falls back to the total rather than draw the slice as the whole.
	const bucketTotal = drawnTotal >= session.totalTokens * BUCKET_COVERAGE_MIN ? drawnTotal : 0
	const total = bucketTotal > 0 ? bucketTotal : session.totalTokens
	// Blank where nothing was reported — a "0" would read as "measured, and it
	// was nothing".
	if (total === 0) return null
	// The bar and the figure are two grid slots rather than a nested flex row:
	// every row's track then starts at the same x, which is the only way segment
	// widths can be read down the list.
	return (
		<Hint
			className="grid grid-cols-[4rem_1fr] items-center gap-2"
			content={
				<div className="flex flex-col gap-0.5 tabular-nums">
					<span className="font-medium">{plural(total, "token")}</span>
					{drawn.map((bucket) => (
						<span key={bucket.key} className="flex items-center gap-1.5">
							<span aria-hidden className={cn("size-1.5 rounded-full", bucket.fill)} />
							{bucket.label}: {buckets[bucket.key].toLocaleString()}
						</span>
					))}
				</div>
			}
		>
			<span className="flex h-1.5 items-center">
				{/* A session that reported only a total draws no bar — an empty track
				    would read as "measured, and it was nothing". */}
				{bucketTotal > 0 && (
					<span aria-hidden className="flex h-1.5 w-full gap-px overflow-hidden rounded-xs bg-muted">
						{drawn.map((bucket) => (
							<span
								key={bucket.key}
								className={bucket.fill}
								style={{ width: `${(buckets[bucket.key] / bucketTotal) * 100}%` }}
							/>
						))}
					</span>
				)}
			</span>
			<span className="font-mono text-xs tabular-nums text-muted-foreground">{formatCount(total)}</span>
		</Hint>
	)
}

/**
 * Tool failures apart from turn failures: a tool that errored is something the
 * agent may have recovered from, a turn that failed is the session not
 * answering — so they are two chips in two tones rather than one count. A
 * failure the index cannot classify (an errored span outside the agent's own)
 * shows only when it is all there is.
 */
function ErrorChips({ session }: { session: AgentSessionRow }) {
	// Unlike cost, none is a measurement here — the index counts every errored
	// span — so the cell says so rather than sitting empty.
	if (session.errorSpanCount === 0) {
		return <span className="text-xs text-muted-foreground/50">—</span>
	}
	const classified = session.toolErrorCount + session.turnErrorCount
	const other = session.errorSpanCount - classified
	return (
		<div className="flex flex-col items-start gap-1">
			{session.turnErrorCount > 0 && (
				<ErrorChip
					icon={FaceRobotIcon}
					count={session.turnErrorCount}
					noun="turn"
					hint={`${plural(session.turnErrorCount, "failed turn")} — a model call or agent turn errored`}
					className="border-destructive/30 bg-destructive/10 text-destructive"
				/>
			)}
			{session.toolErrorCount > 0 && (
				<ErrorChip
					icon={GearIcon}
					count={session.toolErrorCount}
					noun="tool"
					hint={`${plural(session.toolErrorCount, "failed tool call")} — the agent may have recovered`}
					className="border-severity-warn/40 bg-severity-warn/10 text-severity-warn"
				/>
			)}
			{classified === 0 && other > 0 && (
				<ErrorChip
					count={other}
					noun="span"
					hint={`${plural(other, "errored span")} outside the agent's turns and tools`}
					className="border-destructive/30 bg-destructive/10 text-destructive"
				/>
			)}
		</div>
	)
}

function ErrorChip({
	icon: Icon,
	count,
	noun,
	hint,
	className,
}: {
	icon?: IconComponent
	count: number
	noun: string
	hint: string
	className: string
}) {
	return (
		<Hint
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums",
				className,
			)}
			content={hint}
		>
			{Icon ? (
				<Icon size={10} className="shrink-0" aria-hidden />
			) : (
				<span className="size-1 rounded-full bg-current" aria-hidden />
			)}
			{/* Two digits of room, and the noun always as wide as its plural: a
			    row's "1 tool" above the next row's "12 tools" otherwise makes two
			    chips that never line up. Past 99 the chip does widen — a third
			    digit costs every row space for a count almost no session reaches. */}
			<span>
				<span className="inline-block min-w-[2ch] text-right">{count}</span>{" "}
				<span className="inline-block min-w-[5ch]">{count === 1 ? noun : `${noun}s`}</span>
			</span>
		</Hint>
	)
}

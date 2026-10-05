import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"
import { useCallback, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"
import { SignalEmptyState } from "@/components/common/signal-empty-state"
import { ChevronRightIcon } from "@/components/icons"
import { useLiveClock } from "@/hooks/use-live-clock"
import { usePageScrollMargin } from "@/hooks/use-page-scroll-margin"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import type { SessionTag } from "@maple/domain/query-engine"
import { browserIconFor, deviceIconFor } from "./session-icons"
import {
	SESSION_TAG_DESCRIPTIONS,
	SESSION_TAG_DOTS,
	SESSION_TAG_LABELS,
	SESSION_TAG_ORDER,
	SESSION_TAG_STYLES,
} from "./session-tags"
import { sessionListItems } from "./session-list-items"
import { ErrorCountPill, LivePill } from "./session-pills"
import { formatSessionDuration, hostFromUrl, isSessionLive, sessionDurationMs } from "./replay-format"

export interface SessionRow {
	readonly sessionId: string
	readonly startTime: string
	readonly durationMs: number | null
	readonly status: string
	/** Heartbeat timestamp. Paired with `status` to decide live-ness — see
	 *  `isSessionLive`; `status` on its own never stops saying `"active"`. */
	readonly lastActivityAt: string | null
	readonly userId: string | null
	/** identify() identity. `""` on sessions that were never identified. */
	readonly userName: string
	readonly userEmail: string
	readonly groupId: string
	readonly groupName: string
	readonly urlInitial: string
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly country: string
	readonly serviceName: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
	readonly traceCount: number
	/** `"false"` when the SDK recorded no rrweb chunks for this session. `""` on
	 *  sessions written before the marker existed — unknown, so no badge. */
	readonly recorded: string
	/** Rule-based tags; see `SESSION_TAGS`. */
	readonly tags: ReadonlyArray<SessionTag>
}

function absoluteTs(startTime: string, timeZone: string): string {
	const parsed = toEpochMs(startTime)
	return Number.isNaN(parsed) ? startTime : formatTimestampInTimezone(parsed, { timeZone, withYear: true })
}

// A person is easier to recognize by name than by an opaque id, so the label
// walks down to the most human value available. Sessions recorded before
// identify() (or by users who never call it) carry `""` in every identity column
// and fall all the way through to the original userId/Anonymous rendering.
function identityLabel(session: SessionRow): string {
	return session.userName || session.userEmail || session.userId || "Anonymous"
}

// Column widths, shared by the header and every row so the columns line up. Each
// appears at the container width where it still leaves the user column room.
const COLUMNS = {
	org: "hidden w-36 shrink-0 @3xl:flex",
	tags: "hidden w-44 shrink-0 @2xl:flex",
	activity: "hidden w-[12.5rem] shrink-0 @5xl:flex",
	device: "hidden w-[6.5rem] shrink-0 @6xl:flex",
	signals: "hidden w-[8.75rem] shrink-0 @2xl:flex",
	time: "hidden w-24 shrink-0 justify-end @2xl:flex",
} as const

/** Rendered rows (~65px each) past which the sentinel sits below any viewport plus
 *  its 400px root margin, so it only fires once the user scrolls. */
const AUTO_LOAD_MIN_ROWS = 25

interface SessionsListProps {
	sessions: ReadonlyArray<SessionRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	/** Whether more pages remain (renders the sentinel + footer). */
	hasMore?: boolean
	/** Whether a next page is currently in flight. */
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
	/** p95 session duration (ms) from the facets query — sessions above it get a
	 *  "long" chip beside their duration. No chip when unavailable. */
	durationP95?: number
	/** True when any filter or search narrows the list, so the empty state says so. */
	filtered?: boolean
	onClearFilters?: () => void
	/** Fold runs of adjacent bot / bounce / idle / glance sessions into one
	 *  expandable row. Off when a tier filter already chose what to show. */
	collapseLowSignal?: boolean
	/** Narrow the list to sessions carrying this tag; the tag pills become filters. */
	onFilterTag?: (tag: SessionTag) => void
	/** Narrow the list to one identified org; the org cell becomes a filter. */
	onFilterGroup?: (groupName: string) => void
	/** "Now" for the live-ness test, injectable so tests don't chase the clock.
	 *  Left unset it comes from {@link useLiveClock}, which ticks so a pill stops
	 *  claiming LIVE once its window closes even on a list nobody is touching.
	 *  Either way it is sampled once per render, never per row: two rows in one
	 *  frame must not disagree about what time it is. */
	nowMs?: number
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
}: Pick<SessionsListProps, "onReachEnd" | "loadingMore">) {
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

export function SessionsList({
	sessions,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
	durationP95,
	filtered = false,
	onClearFilters,
	collapseLowSignal = false,
	onFilterTag,
	onFilterGroup,
	nowMs,
}: SessionsListProps) {
	const navigate = useNavigate()
	const { effectiveTimezone } = useTimezonePreference()
	// Only sessions still reading `"active"` can cross the live boundary while
	// the list sits open; a page of ended ones needs no timer at all.
	const tickedNowMs = useLiveClock({
		enabled: nowMs === undefined && sessions.some((session) => session.status === "active"),
	})
	const effectiveNowMs = nowMs ?? tickedNowMs
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
	const items = sessionListItems(sessions, {
		collapse: collapseLowSignal,
		expanded,
		nowMs: effectiveNowMs,
	})
	// Folded runs can leave a page of sessions only a few rows tall, which keeps the
	// auto-loading sentinel in view and pulls every page with no scrolling. Ask
	// instead until the rows are tall enough that reaching the end takes a scroll,
	// and whenever the list ends in a folded run: the next page may only extend
	// that run, leaving the sentinel exactly where it was.
	const hidesSessions = items.some((item) => item.kind === "quiet" && !item.expanded)
	const lastItem = items.at(-1)
	const endsInFoldedRun = lastItem?.kind === "quiet" && !lastItem.expanded
	const manualLoadMore = hidesSessions && (items.length < AUTO_LOAD_MIN_ROWS || endsInFoldedRun)
	const toggleRun = (key: string) =>
		setExpanded((previous) => {
			const next = new Set(previous)
			if (!next.delete(key)) next.add(key)
			return next
		})
	const { ref: listRef, getScrollElement, scrollMargin } = usePageScrollMargin()
	const virtualizer = useVirtualizer({
		count: items.length,
		getItemKey: (index) => {
			const item = items[index]!
			return item.kind === "quiet" ? `quiet:${item.key}` : item.session.sessionId
		},
		getScrollElement,
		estimateSize: () => 65,
		overscan: 8,
		scrollMargin,
	})
	const virtualItems = virtualizer.getVirtualItems()

	if (sessions.length === 0) {
		return <SignalEmptyState signal="sessions" filtered={filtered} onClearFilters={onClearFilters} />
	}

	return (
		<div className="@container">
			<ColumnHeader />
			<div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualItems.map((virtualRow) => {
					const item = items[virtualRow.index]!
					const style = {
						transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
					}
					if (item.kind === "quiet") {
						return (
							<div
								key={virtualRow.key}
								data-index={virtualRow.index}
								ref={virtualizer.measureElement}
								className="absolute top-0 left-0 w-full"
								style={style}
							>
								<QuietRunRow
									count={item.count}
									summary={item.summary}
									tiers={item.tiers}
									expanded={item.expanded}
									onToggle={() => toggleRun(item.key)}
								/>
							</div>
						)
					}
					return (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute top-0 left-0 w-full"
							style={style}
						>
							<SessionListRow
								session={item.session}
								lowSignal={item.lowSignal}
								nowMs={effectiveNowMs}
								timeZone={effectiveTimezone}
								durationP95={durationP95}
								onOpen={() =>
									navigate({
										to: "/replays/$sessionId",
										params: { sessionId: item.session.sessionId },
										search: { t: item.session.startTime },
									})
								}
								onFilterTag={onFilterTag}
								onFilterGroup={onFilterGroup}
							/>
						</div>
					)
				})}
			</div>

			{hasMore &&
				(manualLoadMore ? (
					<button
						type="button"
						onClick={() => onReachEnd?.()}
						disabled={loadingMore}
						className="w-full py-3 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
					>
						Load more sessions
					</button>
				) : (
					<SessionsSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />
				))}

			{isCapped && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing first {sessions.length.toLocaleString()} sessions. Narrow filters to continue.
				</p>
			)}

			{loadingMore && (
				<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
					<Spinner className="size-4" />
					Loading more sessions…
				</div>
			)}
		</div>
	)
}

function ColumnHeader() {
	return (
		<div className="hidden items-center gap-4 border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground @2xl:flex">
			<span className="min-w-0 flex-1">User</span>
			<span className={COLUMNS.org}>Org</span>
			<span className={COLUMNS.tags}>Tags</span>
			<span className={COLUMNS.activity}>Activity</span>
			<span className={COLUMNS.device}>Device</span>
			<span className={COLUMNS.signals}>Signals</span>
			<span className={COLUMNS.time}>Started</span>
		</div>
	)
}

interface SessionListRowProps {
	session: SessionRow
	lowSignal: boolean
	nowMs: number
	timeZone: string
	durationP95?: number
	onOpen: () => void
	onFilterTag?: (tag: SessionTag) => void
	onFilterGroup?: (groupName: string) => void
}

/**
 * One session. A stretched button behind the content opens the replay for keyboard
 * users and clicks in the gaps; the columns sit above it (positioned, later in the
 * DOM) so their `title` tooltips still get the hover, and a click on them bubbles
 * to the row. The org and tag pills are their own filter buttons, never nested in
 * the row's button.
 */
function SessionListRow({
	session,
	lowSignal,
	nowMs,
	timeZone,
	durationP95,
	onOpen,
	onFilterTag,
	onFilterGroup,
}: SessionListRowProps) {
	const label = identityLabel(session)
	const muted = lowSignal || session.recorded === "false"
	const isActive = isSessionLive(session, nowMs)
	const durationMs = sessionDurationMs(session)
	const hasErrors = session.errorCount > 0
	const entry = hostFromUrl(session.urlInitial)
	// The email goes under a name; when the email is the label, the entry page does.
	const secondary = session.userEmail && session.userEmail !== label ? session.userEmail : entry
	const started = formatRelativeTimeOrDate(session.startTime, undefined, timeZone)
	const BrowserIcon = browserIconFor(session.browserName)
	const DeviceIcon = deviceIconFor(session.deviceType)

	return (
		<div
			onClick={(event) => {
				// The stretched button and the filter pills handle their own clicks.
				if (event.target instanceof Element && event.target.closest("button")) return
				onOpen()
			}}
			className={cn(
				"group relative flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 transition-colors hover:bg-accent/40 @2xl:gap-4",
				lowSignal ? "py-1.5" : "py-2.5",
			)}
		>
			<button
				type="button"
				onClick={onOpen}
				aria-label={`Open session from ${label}`}
				className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			/>
			{/* Errored sessions get a left accent so they can be picked out
			    while scanning — the strongest "watch this one first" signal. */}
			{hasErrors && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />}

			{/* User: name, then email or entry page. Below @2xl the other columns
			    stack underneath it. */}
			<div className="relative min-w-0 flex-1 overflow-hidden">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"min-w-0 truncate text-sm font-medium",
							muted && "text-muted-foreground",
						)}
					>
						{label}
					</span>
					{isActive && <LivePill compact />}
					<span
						className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
						title={absoluteTs(session.startTime, timeZone)}
					>
						{started}
					</span>
				</div>
				<div
					className={cn(
						"mt-0.5 truncate text-xs text-muted-foreground",
						secondary === entry && "font-mono",
					)}
					title={entry}
				>
					{secondary}
				</div>
				{/* Tags and signals get their own columns at @2xl, the org only at @3xl,
				    so the org stays in this stacked line through the band between. */}
				<div
					className={cn(
						"mt-1.5 flex flex-wrap items-center gap-1.5",
						session.groupName ? "@3xl:hidden" : "@2xl:hidden",
					)}
				>
					{session.groupName && <OrgButton name={session.groupName} onFilter={onFilterGroup} />}
					<div className="contents @2xl:hidden">
						<SessionTags tags={session.tags} onFilter={onFilterTag} />
						<SessionBadges session={session} />
					</div>
				</div>
			</div>

			<div className={cn(COLUMNS.org, "relative min-w-0 items-center")}>
				{session.groupName ? (
					<OrgButton name={session.groupName} onFilter={onFilterGroup} />
				) : (
					<span className="text-xs text-muted-foreground/50">—</span>
				)}
			</div>

			<div className={cn(COLUMNS.tags, "relative flex-wrap items-center gap-1")}>
				<SessionTags tags={session.tags} onFilter={onFilterTag} />
			</div>

			<div
				className={cn(
					COLUMNS.activity,
					"relative items-baseline gap-2 overflow-hidden whitespace-nowrap",
				)}
			>
				<span
					className={cn(
						"font-mono text-[13px] font-semibold tabular-nums",
						lowSignal && "font-normal text-muted-foreground",
					)}
				>
					{formatSessionDuration(durationMs)}
				</span>
				{durationP95 != null && durationP95 > 0 && durationMs != null && durationMs > durationP95 && (
					<span
						className="shrink-0 self-center rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-accent-foreground"
						title={`Longer than 95% of sessions in this view (p95: ${formatSessionDuration(durationP95)})`}
					>
						long
					</span>
				)}
				<span className="truncate text-xs text-muted-foreground">
					{session.pageViews || 1} page{(session.pageViews || 1) === 1 ? "" : "s"} ·{" "}
					{session.clickCount} click{session.clickCount === 1 ? "" : "s"}
				</span>
			</div>

			<div className={cn(COLUMNS.device, "relative items-center gap-2.5")}>
				<span
					className="shrink-0"
					title={`${session.browserName || "Unknown"}${session.osName ? ` · ${session.osName}` : ""}`}
				>
					<BrowserIcon className="size-4" />
				</span>
				<span className="shrink-0 text-muted-foreground" title={session.deviceType || "desktop"}>
					<DeviceIcon className="size-4 opacity-70" />
				</span>
				{session.country && (
					<span className="truncate text-xs text-muted-foreground">{session.country}</span>
				)}
			</div>

			<div className={cn(COLUMNS.signals, "relative items-center gap-1.5 overflow-hidden")}>
				<SessionBadges session={session} />
			</div>

			<div className={cn(COLUMNS.time, "relative items-center")}>
				<span
					className="whitespace-nowrap text-xs text-muted-foreground"
					title={absoluteTs(session.startTime, timeZone)}
				>
					{started}
				</span>
			</div>
		</div>
	)
}

function OrgButton({ name, onFilter }: { name: string; onFilter?: (groupName: string) => void }) {
	const className = "min-w-0 truncate text-xs font-medium text-foreground"
	if (!onFilter) return <span className={className}>{name}</span>
	return (
		<button
			type="button"
			onClick={() => onFilter(name)}
			title={`Only sessions from ${name}`}
			className={cn(className, "rounded hover:underline")}
		>
			{name}
		</button>
	)
}

function SessionTags({
	tags,
	onFilter,
}: {
	tags: ReadonlyArray<SessionTag>
	onFilter?: (tag: SessionTag) => void
}) {
	return (
		<>
			{SESSION_TAG_ORDER.filter((tag) => tags.includes(tag)).map((tag) => {
				const className = cn(
					"inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium",
					SESSION_TAG_STYLES[tag],
				)
				if (!onFilter) {
					return (
						<span key={tag} className={className} title={SESSION_TAG_DESCRIPTIONS[tag]}>
							{SESSION_TAG_LABELS[tag]}
						</span>
					)
				}
				return (
					<button
						key={tag}
						type="button"
						onClick={() => onFilter(tag)}
						title={`${SESSION_TAG_DESCRIPTIONS[tag]}. Click to filter.`}
						className={cn(className, "hover:ring-1 hover:ring-border")}
					>
						{SESSION_TAG_LABELS[tag]}
					</button>
				)
			})}
		</>
	)
}

function SessionBadges({ session }: { session: SessionRow }) {
	return (
		<>
			{session.errorCount > 0 && <ErrorCountPill count={session.errorCount} />}
			{session.traceCount > 0 && (
				<span className="inline-flex shrink-0 items-center rounded-full bg-indigo-500/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-indigo-600 dark:text-indigo-400">
					{session.traceCount} trace{session.traceCount === 1 ? "" : "s"}
				</span>
			)}
			{/* Metadata-only session — no rrweb chunks were ever written, so the
			    detail page has no player. Flag it here rather than let the row look
			    like every other (playable) session. */}
			{session.recorded === "false" && (
				<span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
					Transcript only
				</span>
			)}
		</>
	)
}

/** Stands in for a run of low-signal sessions; the list stays in time order. */
function QuietRunRow({
	count,
	summary,
	tiers,
	expanded,
	onToggle,
}: {
	count: number
	summary: string
	tiers: ReadonlyArray<{ readonly tag: SessionTag; readonly count: number }>
	expanded: boolean
	onToggle: () => void
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			className="flex w-full items-center gap-3 border-b border-border bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @2xl:gap-4"
		>
			<span className="shrink-0 whitespace-nowrap font-medium tabular-nums">
				{count} low-signal session{count === 1 ? "" : "s"}
			</span>
			<span className="flex min-w-0 items-center gap-3 overflow-hidden" title={summary}>
				{tiers.map(({ tag, count: n }) => (
					<span key={tag} className="flex shrink-0 items-center gap-1.5">
						<StatusDot tone="custom" className={SESSION_TAG_DOTS[tag]} />
						<span className="tabular-nums">{n}</span> {SESSION_TAG_LABELS[tag].toLowerCase()}
						{n === 1 ? "" : "s"}
					</span>
				))}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1">
				{expanded ? "Hide" : "Show"}
				<ChevronRightIcon
					size={14}
					aria-hidden
					className={cn("transition-transform", expanded && "rotate-90")}
				/>
			</span>
		</button>
	)
}

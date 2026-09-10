import { useCallback } from "react"
import { Link } from "@tanstack/react-router"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
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
import { useDetectedModels } from "@/hooks/use-detected-models"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { sessionLinkWindow, sessionRowId } from "@/lib/agent-sessions/session-window"
import { TOKEN_BUCKETS, type TokenBucketKey } from "@/lib/agent-sessions/token-buckets"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { ModelLabel } from "./model-label"
import { sessionIdentity } from "./session-detail/session-header"
import { CATEGORY_TEXT } from "./session-detail/span-visuals"

/** The wire row from `listAiSessions` — one AI agent session, newest first. */
export interface AgentSessionRow {
	readonly sessionId: string
	readonly vendorId: string
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

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

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

interface AgentSessionsListProps {
	sessions: ReadonlyArray<AgentSessionRow>
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

export function AgentSessionsList({
	sessions,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
}: AgentSessionsListProps) {
	const { effectiveTimezone } = useTimezonePreference()
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

	// One batch for the whole page, re-asked only when paging brings a model
	// the list has not seen. Before it lands every row still names its model.
	const detect = useDetectedModels(sessions.flatMap((session) => session.models))

	return (
		<div className="@container">
			{sessions.map((session) => {
				const hasErrors = session.errorSpanCount > 0
				const VendorIcon = vendorIcon(session.vendorId)
				const vendor = vendorLabel(session.vendorId)
				// `sessionIdentity` reads the first name, so it is handed the one
				// name the warehouse resolved in span order rather than the
				// unordered `agentNames` set — see `firstAgentName`.
				const { heading } = sessionIdentity({
					agentNames: session.firstAgentName === "" ? [] : [session.firstAgentName],
					vendorIds: [session.vendorId],
				})
				const [firstModel, ...otherModels] = session.models
				return (
					<Link
						key={session.sessionId}
						to="/agent-sessions/$sessionId"
						params={{ sessionId: session.sessionId }}
						// The session's own bounds, not the list's window — its agent spans'
						// extent until the row's details land, the true one after — so the
						// detail page reads straight from these.
						search={sessionLinkWindow(session)}
						className="relative flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @2xl:gap-4"
					>
						{/* Errored sessions get a left accent so they can be picked out
						    while scanning — same signal as the replays list. */}
						{hasErrors && (
							<span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
						)}

						{/* Identity lane: what the session IS on the first line — the agent
						    it ran, beside the framework's mark — and what it is CALLED on
						    the second. The id is how you cite a session, not how you
						    recognise one, so it reads as metadata under the name. */}
						<div className="min-w-0 flex-1 overflow-hidden">
							<div className="flex items-center gap-2">
								<span
									className="flex shrink-0 items-center text-muted-foreground"
									title={vendor}
								>
									<VendorIcon size={15} aria-hidden />
								</span>
								<span className="min-w-0 truncate text-sm font-medium" title={heading}>
									{heading}
								</span>
								{/* On phones the right-hand lanes are gone, so the timestamp
								    anchors the top-right corner of the stacked row. */}
								<span
									className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
									title={absoluteTs(session.startTime, effectiveTimezone)}
								>
									{formatRelativeTimeOrDate(
										session.startTime,
										undefined,
										effectiveTimezone,
									)}
								</span>
							</div>
							<div
								className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
								title={session.sessionId}
							>
								{sessionRowId(session.sessionId)}
							</div>
							{hasErrors && (
								<div className="mt-1.5 flex flex-wrap items-center gap-1.5 @2xl:hidden">
									<ErrorChips session={session} />
								</div>
							)}
						</div>

						{/* Services lane */}
						<div className="hidden w-[10rem] shrink-0 overflow-hidden @2xl:block">
							<span
								className="block truncate text-xs text-muted-foreground"
								title={session.serviceNames.join(", ")}
							>
								{session.serviceNames.join(" · ")}
							</span>
						</div>

						{/* Model lane: what the session ran on. Last lane in, because it is
						    the one a reader can also get from the filter rail — every lane's
						    breakpoint is set so the identity lane keeps a legible ~180px
						    even at the width where the lane appears. The first model by
						    name and mark, the rest as a count; the raw ids gateways report
						    stay in the title, where two models that truncate alike are
						    still told apart. */}
						<div className="hidden w-[9rem] shrink-0 overflow-hidden text-xs text-muted-foreground @7xl:block">
							{firstModel !== undefined && (
								<ModelLabel
									detected={detect(firstModel)}
									moreCount={otherModels.length}
									title={session.models.join(", ")}
								/>
							)}
						</div>

						{/* Activity lane: duration + the work done, in the session page's
						    colours for inference and tools. Traces and spans move to the
						    tooltip — they describe ingestion, calls and tools describe the
						    agent. */}
						<div
							className="hidden w-[15.25rem] shrink-0 grid-cols-[4.25rem_5.5rem_5.5rem] items-center overflow-hidden whitespace-nowrap @4xl:grid"
							title={`${plural(session.traceCount, "trace")} · ${plural(session.spanCount, "span")}`}
						>
							<span className="font-mono text-[13px] font-semibold tabular-nums">
								{formatSessionDuration(session.durationMs)}
							</span>
							<WorkCount
								icon={PixelSparkleIcon}
								tone={CATEGORY_TEXT.inference}
								count={session.llmCalls}
								noun="call"
							/>
							<WorkCount
								icon={GearIcon}
								tone={CATEGORY_TEXT.tool}
								count={session.toolCalls}
								noun="tool"
							/>
						</div>

						{/* Usage lane: the token buckets as a bar, the total and the cost.
						    Blank where nothing was reported — a "0" here would read as
						    "measured, and it was free". */}
						<div className="hidden w-[12rem] shrink-0 grid-cols-[4rem_4.25rem_1fr] items-center gap-2 overflow-hidden whitespace-nowrap @6xl:grid">
							<TokenBar session={session} />
							<span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
								{session.cost > 0 ? formatCost(session.cost) : ""}
							</span>
						</div>

						{/* Signal lane: what failed, tools apart from turns */}
						<div className="hidden w-[7.5rem] shrink-0 flex-col items-start justify-center gap-1 overflow-hidden @2xl:flex">
							{hasErrors && <ErrorChips session={session} />}
						</div>

						{/* Time lane. Fixed width and right-aligned: sized to its content it
						    is a lane whose width changes per row, which drags every lane to
						    its left out of column with the row above. */}
						<div className="hidden w-[4.5rem] shrink-0 items-center justify-end @2xl:flex">
							<span
								className="truncate text-right text-xs text-muted-foreground"
								title={absoluteTs(session.startTime, effectiveTimezone)}
							>
								{formatRelativeTimeOrDate(session.startTime, undefined, effectiveTimezone)}
							</span>
						</div>
					</Link>
				)
			})}

			{hasMore && <SessionsSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing the {sessions.length.toLocaleString()} most recent sessions — filter the list to
					see older ones
				</p>
			)}

			{loadingMore && (
				<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
					<span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
					Loading more sessions…
				</div>
			)}
		</div>
	)
}

/** "12 calls" with the kind's glyph, in its hue — the same pair the session
 *  page's waterfall and flow use for the kind of work. */
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
	// Compact: a busy session runs to four and five figures, and the lane's slot
	// is sized for the label, not for the widest count it will ever hold.
	return (
		<span
			className={cn("inline-flex items-center gap-1 text-xs tabular-nums", tone)}
			title={plural(count, noun)}
		>
			<Icon size={12} className="shrink-0" aria-hidden />
			{formatCount(count)} {noun}
			{count === 1 ? "" : "s"}
		</span>
	)
}

/**
 * The detail page's Tokens rail at row height: one segment per non-empty
 * bucket, in that rail's fills, so cached against fresh against generated can
 * be compared down the list. The figure beside the bar is the buckets' sum —
 * the number the detail page's header reaches — and falls back to the index's
 * total only for a session that reported no buckets. The two can differ: the
 * index sums the reported figures as stamped, the buckets carve the cache back
 * out of an inclusive prompt figure, and the sort and filter read the index.
 */
/** The share of the index's total the buckets must reach to be drawn — the
 *  dedupe can leave the two a little apart, never this far. */
const BUCKET_COVERAGE_MIN = 0.9

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
	const title = [
		`${total.toLocaleString()} tokens`,
		...drawn.map((bucket) => `${bucket.label}: ${buckets[bucket.key].toLocaleString()}`),
	].join("\n")
	// The bar and the figure are two of the lane's grid slots rather than a
	// nested flex row: every row's track then starts at the same x, which is the
	// only way segment widths can be read down the list.
	return (
		<>
			<span className="flex h-1.5 items-center" title={title}>
				{/* A session that reported only a total draws no bar — an empty track
				    would read as "measured, and it was nothing". */}
				{bucketTotal > 0 && (
					<span
						aria-hidden
						className="flex h-1.5 w-full gap-px overflow-hidden rounded-xs bg-muted"
					>
						{drawn.map((bucket) => (
							<span
								key={bucket.key}
								className={bucket.fill}
								style={{
									width: `${(buckets[bucket.key] / bucketTotal) * 100}%`,
								}}
							/>
						))}
					</span>
				)}
			</span>
			<span className="text-right font-mono text-xs tabular-nums text-muted-foreground" title={title}>
				{total > 0 ? `${formatCount(total)} tok` : ""}
			</span>
		</>
	)
}

/**
 * Tool failures apart from turn failures: a tool that errored is something the
 * agent may have recovered from, a turn that failed is the session not
 * answering — so they are two chips in two tones rather than one count. A
 * failure the index cannot classify (an errored span outside the agent's own)
 * still lights the row's accent, and shows here only when it is all there is.
 */
function ErrorChips({ session }: { session: AgentSessionRow }) {
	const classified = session.toolErrorCount + session.turnErrorCount
	const other = Math.max(0, session.errorSpanCount - classified)
	return (
		<>
			{session.turnErrorCount > 0 && (
				<ErrorChip
					icon={FaceRobotIcon}
					count={session.turnErrorCount}
					noun="turn error"
					className="border-destructive/30 bg-destructive/10 text-destructive"
				/>
			)}
			{session.toolErrorCount > 0 && (
				<ErrorChip
					icon={GearIcon}
					count={session.toolErrorCount}
					noun="tool error"
					className="border-severity-warn/40 bg-severity-warn/10 text-severity-warn"
				/>
			)}
			{classified === 0 && other > 0 && (
				<ErrorChip
					count={other}
					noun="error"
					className="border-destructive/30 bg-destructive/10 text-destructive"
				/>
			)}
		</>
	)
}

function ErrorChip({
	icon: Icon,
	count,
	noun,
	className,
}: {
	icon?: IconComponent
	count: number
	noun: string
	className: string
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums",
				className,
			)}
		>
			{Icon ? (
				<Icon size={10} className="shrink-0" aria-hidden />
			) : (
				<span className="size-1 rounded-full bg-current" aria-hidden />
			)}
			{/* Two digits of room, and the noun always as wide as its plural: a
			    row's "1 tool error" above the next row's "12 tool errors"
			    otherwise makes two chips that never line up. Past 99 the chip does
			    widen — a third digit costs every row space for a count almost no
			    session reaches. */}
			<span>
				<span className="inline-block min-w-[2ch] text-right">{count}</span>{" "}
				<span className="inline-block" style={{ minWidth: `${noun.length + 1}ch` }}>
					{count === 1 ? noun : `${noun}s`}
				</span>
			</span>
		</span>
	)
}

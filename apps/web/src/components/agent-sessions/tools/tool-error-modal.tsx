import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { Dialog, DialogPopup } from "@maple/ui/components/ui/dialog"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { cn } from "@maple/ui/lib/utils"
import { formatBytes } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, XmarkIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { useDetectedModels, type DetectedModel } from "@/hooks/use-detected-models"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { sessionRowId } from "@/lib/agent-sessions/session-window"
import {
	errorTypeLabel,
	formatDurationNs,
	formatToolCount,
	type ToolErrorOccurrenceRow,
	type ToolErrorRow,
	type ToolErrorSessionRow,
} from "@/lib/agent-sessions/tool-analytics"
import { ModelLabel } from "../model-label"
import { SessionName } from "../session-name"

export interface ToolErrorDetailData {
	readonly sessions: ReadonlyArray<ToolErrorSessionRow>
	readonly occurrences: ReadonlyArray<ToolErrorOccurrenceRow>
}

type Detect = (model: string) => DetectedModel

/**
 * One error type of one tool, in full: which sessions hit it, and the calls
 * themselves with what they were called with and what came back.
 *
 * A modal rather than a route of its own because it is a reading of the row
 * behind it — closing it puts the reader back in the ranked list they were
 * scanning, which is the whole loop this page is for. The error type stays in
 * the URL regardless, so the reading is still linkable.
 *
 * Two panes, and only the right one is filtered by the left: picking a session
 * narrows the occurrences, and the session list stays whole so the reader can
 * pick a different one without closing anything. A session's NAME is the way
 * out to the session itself, in both panes.
 */
export function ToolErrorModal({
	tool,
	error,
	data,
	failure,
	toolFailures,
	session,
	onSelectSession,
	onClose,
	waiting,
	loading,
}: {
	tool: string
	/** The row the modal was opened from — its totals are the header's. */
	error: ToolErrorRow
	data: ToolErrorDetailData
	/** The occurrences read failed. The header still stands — it came from the
	 *  row behind the modal — and the two panes are replaced by the failure. */
	failure?: unknown
	/** Every failed call of this tool, for the "N% of <tool> failures" line. */
	toolFailures: number
	/** The session the occurrences are narrowed to, or none. */
	session: string | undefined
	onSelectSession: (session: string | undefined) => void
	onClose: () => void
	waiting?: boolean
	/** The occurrences read has not answered — the modal opens before it does. */
	loading?: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const detect = useDetectedModels(
		[...data.sessions, ...data.occurrences].map((row) => row.model).filter((model) => model !== ""),
	)
	const share = toolFailures > 0 ? Math.round((error.calls / toolFailures) * 100) : 0
	// Narrowed to a session, the occurrences are that session's, so their total is
	// its hits rather than the error's.
	const occurrencesTotal =
		session === undefined
			? error.calls
			: (data.sessions.find((row) => row.sessionId === session)?.hits ?? data.occurrences.length)

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			<DialogPopup
				showCloseButton={false}
				bottomStickOnMobile={false}
				className={cn(
					"h-[86vh] w-[94vw] max-w-none gap-0 overflow-clip p-0",
					"max-sm:h-[calc(100dvh-2rem)] max-sm:w-[calc(100vw-2rem)]",
				)}
			>
				<div data-slot="tool-error-modal" className="flex min-h-0 min-w-0 grow flex-col">
					<header className="flex shrink-0 items-start justify-between gap-6 border-b border-border px-6 pt-5 pb-4">
						<div className="flex min-w-0 flex-col gap-1.5">
							<div className="flex items-center gap-2.5 font-mono text-[11px] leading-3.5 text-muted-foreground/80">
								<span>{tool}</span>
								<span className="text-muted-foreground/40">/</span>
								<span>error</span>
							</div>
							<h2
								className={cn(
									"font-mono text-[22px] font-semibold leading-[26px] tracking-[-0.01em]",
									error.errorType === "" ? "text-muted-foreground" : "text-[var(--severity-error)]",
								)}
							>
								{errorTypeLabel(error.errorType)}
							</h2>
							{/* The message on a line of its own: beside the type it wrapped
							    under it anyway, and a long one pushed the facts off-screen. */}
							{error.message === "" ? null : (
								<p
									className="line-clamp-3 max-w-[100ch] break-words font-mono text-[13px] leading-[18px] text-foreground/85"
									title={error.message}
								>
									{error.message}
								</p>
							)}
							<div className="mt-1 flex flex-wrap items-center gap-3.5 font-mono text-[11.5px] leading-3.5 text-muted-foreground">
								<Fact>{formatToolCount(error.calls)} occurrences</Fact>
								<Fact>{formatToolCount(error.sessions)} sessions</Fact>
								<Fact>
									{share}% of {tool} failures
								</Fact>
								<Fact>
									first seen{" "}
									{formatTimestampInTimezone(error.firstSeen, { timeZone: effectiveTimezone })}
								</Fact>
								<Fact>
									last seen{" "}
									{formatRelativeTimeOrDate(error.lastSeen, undefined, effectiveTimezone)}
								</Fact>
							</div>
						</div>

						<div className="flex shrink-0 items-center gap-2">
							<Link
								to="/agent-sessions"
								// The sessions list reads `tools`, not `toolNames` — see its
								// own search schema.
								search={{ tools: [tool], hasErrors: true }}
								className="inline-flex h-[30px] items-center gap-2 rounded-md border border-border bg-card px-2.5 font-mono text-[11.5px] text-foreground transition-colors hover:bg-muted/50"
							>
								Open in Sessions
								<ExternalLinkIcon size={11} className="text-muted-foreground" aria-hidden />
							</Link>
							<button
								type="button"
								onClick={onClose}
								aria-label="Close"
								className="inline-flex size-[30px] items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
							>
								<XmarkIcon size={12} aria-hidden />
							</button>
						</div>
					</header>

					{failure !== undefined ? (
						<QueryErrorState
							error={failure}
							titleOverride={`Failed to load ${errorTypeLabel(error.errorType)} occurrences`}
						/>
					) : (
						<div
							className={cn(
								"flex min-h-0 grow transition-opacity max-md:flex-col",
								waiting && "opacity-60",
							)}
						>
							<SessionsPane
								tool={tool}
								rows={data.sessions}
								total={error.sessions}
								occurrences={error.calls}
								lastSeen={error.lastSeen}
								selected={session}
								onSelect={onSelectSession}
								detect={detect}
							/>
							{/* Keyed by session: a different session is a different list, and
							    its first occurrence opens as the first one did. */}
							<OccurrencesPane
								key={session ?? ""}
								tool={tool}
								rows={data.occurrences}
								total={occurrencesTotal}
								loading={loading}
								detect={detect}
							/>
						</div>
					)}
				</div>
			</DialogPopup>
		</Dialog>
	)
}

function Fact({ children }: { children: React.ReactNode }) {
	return (
		<>
			<span className="text-muted-foreground">{children}</span>
			<span aria-hidden className="text-muted-foreground/40 last:hidden">
				·
			</span>
		</>
	)
}

/**
 * The session's name, linking to the session: the trace view, filtered to this
 * tool, as the tool page's own sessions list opens it.
 *
 * No `t`/`end`, unlike that list: its rows carry the session's bounds, and these
 * carry only the failures'. The detail page reads a window hint AS the window,
 * so the failures' extent would cut every session that ran on past them; left
 * off, the page resolves the session's true bounds once and stamps them.
 *
 * Positioned, so it sits above the row's stretched button: the rest of the row
 * is that button, and an anchor inside a button is invalid nesting.
 */
function SessionLink({
	tool,
	sessionId,
	vendorId,
	agentName,
	spanId,
	className,
}: {
	tool: string
	sessionId: string
	vendorId: string
	agentName: string
	/** The failed call, opened in the detail page's span panel. */
	spanId?: string
	className?: string
}) {
	return (
		<Link
			to="/agent-sessions/$sessionId"
			params={{ sessionId }}
			search={{ tool, view: "trace", ...(spanId !== undefined && { span: spanId }) }}
			className={cn(
				"relative flex min-w-0 items-center gap-1.5 rounded-sm text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		>
			<SessionName agentName={agentName} vendorId={vendorId} iconSize={13} />
			<ExternalLinkIcon
				size={10}
				className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
				aria-hidden
			/>
		</Link>
	)
}

/** Which sessions hit this error, and how hard. `All sessions` is the way back
 *  out of a selection, and is what the pane opens on. */
function SessionsPane({
	tool,
	rows,
	total,
	occurrences,
	lastSeen,
	selected,
	onSelect,
	detect,
}: {
	tool: string
	rows: ReadonlyArray<ToolErrorSessionRow>
	total: number
	occurrences: number
	lastSeen: number
	selected: string | undefined
	onSelect: (session: string | undefined) => void
	detect: Detect
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const relative = (ms: number) => formatRelativeTimeOrDate(ms, undefined, effectiveTimezone)
	const rowClass = (isSelected: boolean) =>
		cn(
			"group relative flex w-full shrink-0 items-center gap-3 border-b border-l-2 border-border/50 pr-4 pl-3.5 text-left transition-colors",
			isSelected ? "border-l-primary bg-primary/10" : "border-l-transparent hover:bg-muted/30",
		)

	return (
		<div className="flex w-[400px] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar max-md:h-56 max-md:w-full max-md:border-r-0 max-md:border-b">
			<div className="flex shrink-0 items-baseline gap-2 px-4 pt-4 pb-2.5 font-mono">
				<span className="text-[12.5px] font-medium text-foreground">Sessions</span>
				<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
					{formatToolCount(total)}
				</span>
			</div>

			<div className="flex h-[30px] shrink-0 items-center gap-3 border-y border-border px-4 font-mono text-[10.5px] uppercase leading-3.5 tracking-[0.07em] text-muted-foreground/80">
				<span className="grow">Session</span>
				<span className="w-12 shrink-0 text-right">Hits</span>
				<span className="w-[72px] shrink-0 text-right">Last</span>
			</div>

			<div className="min-h-0 grow overflow-y-auto overscroll-contain">
				<button
					type="button"
					aria-pressed={selected === undefined}
					onClick={() => onSelect(undefined)}
					className={cn(rowClass(selected === undefined), "h-10")}
				>
					<span className="grow font-mono text-[12.5px] font-medium text-foreground">All sessions</span>
					<span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
						{formatToolCount(occurrences)}
					</span>
					<span className="w-[72px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70">
						{relative(lastSeen)}
					</span>
				</button>

				{rows.map((row) => {
					const isSelected = row.sessionId === selected
					return (
						<div key={row.sessionId} className={cn(rowClass(isSelected), "h-14")}>
							{/* Stretched under the row: a click anywhere but the name
							    narrows the occurrences to this session. */}
							<button
								type="button"
								aria-pressed={isSelected}
								aria-label={`Show occurrences in ${sessionRowId(row.sessionId)}`}
								onClick={() => onSelect(isSelected ? undefined : row.sessionId)}
								className="absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
							/>
							<span className="flex w-0 min-w-0 grow flex-col items-start gap-1">
								<SessionLink
									tool={tool}
									sessionId={row.sessionId}
									vendorId={row.vendorId}
									agentName={row.agentName}
									className="max-w-full font-mono text-[12.5px] font-medium"
								/>
								{/* Under the name, past its mark: what it ran on, and the id
								    it is cited by. */}
								<span className="flex w-full min-w-0 items-center gap-1.5 pl-[21px] text-[11px] leading-3.5 text-muted-foreground">
									{row.model === "" ? null : (
										<>
											<ModelLabel
												detected={detect(row.model)}
												size={11}
												className="max-w-[60%] shrink-0"
											/>
											<span aria-hidden className="text-muted-foreground/40">
												·
											</span>
										</>
									)}
									<span
										className="min-w-0 truncate font-mono text-muted-foreground/70"
										title={row.sessionId}
									>
										{sessionRowId(row.sessionId)}
									</span>
								</span>
							</span>
							<span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
								{formatToolCount(row.hits)}
							</span>
							<span className="w-[72px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70">
								{relative(row.lastSeen)}
							</span>
						</div>
					)
				})}

				<div className="flex h-9 items-center gap-[9px] px-4 font-mono text-xs">
					<span className="text-muted-foreground">
						Showing {formatToolCount(rows.length)} of {formatToolCount(total)}
					</span>
					{rows.length < total ? (
						<span className="text-muted-foreground/60">narrow the range for the rest</span>
					) : null}
				</div>
			</div>
		</div>
	)
}

/** The calls themselves. The first is open, because a modal that opens onto a
 *  list of collapsed rows makes the reader click to see the thing they asked for. */
function OccurrencesPane({
	tool,
	rows,
	total,
	loading,
	detect,
}: {
	tool: string
	rows: ReadonlyArray<ToolErrorOccurrenceRow>
	total: number
	loading?: boolean
	detect: Detect
}) {
	// `null` until the reader touches a row: the pane is mounted before its rows
	// arrive (the modal opens on the row behind it and fills in), so a set seeded
	// at mount would be seeded from nothing and open none of them.
	const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null)
	const firstSpanId = rows[0]?.spanId
	const isOpen = (spanId: string) => (expanded === null ? spanId === firstSpanId : expanded.has(spanId))
	const toggle = (spanId: string) =>
		setExpanded((previous) => {
			const next = new Set(previous ?? (firstSpanId === undefined ? [] : [firstSpanId]))
			if (next.has(spanId)) next.delete(spanId)
			else next.add(spanId)
			return next
		})

	return (
		<div className="flex min-w-0 grow flex-col overflow-hidden">
			<div className="flex shrink-0 items-baseline gap-2 px-6 pt-4 pb-2.5 font-mono">
				<span className="text-[12.5px] font-medium text-foreground">Occurrences</span>
				<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
					{formatToolCount(total)}
				</span>
			</div>

			<div className="min-h-0 grow overflow-y-auto overscroll-contain border-t border-border">
				{loading && rows.length === 0 ? (
					<div className="flex flex-col gap-1.5 px-6 py-3">
						<Skeleton className="h-10" />
						<Skeleton className="h-10" />
						<Skeleton className="h-10" />
					</div>
				) : rows.length === 0 ? (
					<div className="px-6 py-12 text-center font-mono text-xs text-muted-foreground">
						No occurrences in the selected window.
					</div>
				) : (
					rows.map((row) => (
						<Occurrence
							key={row.spanId}
							tool={tool}
							row={row}
							open={isOpen(row.spanId)}
							onToggle={() => toggle(row.spanId)}
							detect={detect}
						/>
					))
				)}

				<div className="flex h-9 items-center gap-[9px] px-6 font-mono text-xs">
					<span className="text-muted-foreground">
						Showing {formatToolCount(rows.length)} of {formatToolCount(total)}
					</span>
					{rows.length < total ? (
						<span className="text-muted-foreground/60">narrow the range for the rest</span>
					) : null}
				</div>
			</div>
		</div>
	)
}

function Occurrence({
	tool,
	row,
	open,
	onToggle,
	detect,
}: {
	tool: string
	row: ToolErrorOccurrenceRow
	open: boolean
	onToggle: () => void
	detect: Detect
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon
	const time = formatTimestampInTimezone(row.timestamp, { timeZone: effectiveTimezone })
	return (
		<div className="border-b border-border/50">
			{/* The toggle is stretched under the row and the two links sit above it,
			    as siblings: an anchor inside a button is invalid nesting, and
			    browsers reparent it out of the button rather than rendering what
			    was written. The error type is not repeated — the modal is one type. */}
			<div className="group relative flex h-10 w-full items-center gap-3.5 px-6 font-mono transition-colors hover:bg-muted/30">
				<button
					type="button"
					aria-expanded={open}
					aria-label={`Occurrence at ${time}`}
					onClick={onToggle}
					className="absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
				/>
				<Chevron size={12} className="shrink-0 text-muted-foreground" aria-hidden />
				<span className="shrink-0 text-[12.5px] text-foreground">{time}</span>
				<SessionLink
					tool={tool}
					sessionId={row.sessionId}
					vendorId={row.vendorId}
					agentName={row.agentName}
					spanId={row.spanId}
					className="text-xs"
				/>
				{/* A plain breakpoint, not a container query: the dialog is portalled
				    out of the page's container, so `@min-…/page` never matches here. */}
				{row.model === "" ? null : (
					<ModelLabel
						detected={detect(row.model)}
						size={11}
						className="hidden shrink text-xs text-muted-foreground lg:flex"
					/>
				)}
				<span className="grow" />
				<span className="shrink-0 text-xs tabular-nums text-foreground/85">
					{formatDurationNs(row.durationNs)}
				</span>
				<Link
					to="/traces/$traceId"
					params={{ traceId: row.traceId }}
					// The call's own timestamp narrows the trace read to one partition;
					// without it the detail page scans every retained day.
					search={{ spanId: row.spanId, t: formatWarehouseDateTime(row.timestamp) }}
					className="relative flex shrink-0 items-center gap-[5px] text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
				>
					Open trace
					<ExternalLinkIcon size={11} aria-hidden />
				</Link>
			</div>

			{open ? (
				<div className="flex gap-4 px-6 pb-5 pl-[50px] max-md:flex-col">
					<Payload
						label="Arguments"
						attribute="gen_ai.tool.call.arguments"
						bytes={row.argumentsBytes}
						body={row.arguments}
					/>
					<Payload
						label="Result"
						attribute="gen_ai.tool.call.result"
						note={`status ${row.statusCode === "" ? "Unset" : row.statusCode}`}
						bytes={row.resultBytes}
						body={row.result === "" ? row.message : row.result}
						failed
					/>
				</div>
			) : null}
		</div>
	)
}

/** One side of the pair: what the tool was handed, or what it gave back. The
 *  attribute is named because these are spans, and a reader who wants the raw
 *  one needs to know what to look for. */
function Payload({
	label,
	attribute,
	note,
	bytes,
	body,
	failed,
}: {
	label: string
	attribute: string
	note?: string
	bytes: number
	body: string
	failed?: boolean
}) {
	return (
		<div className="flex min-w-0 grow basis-0 flex-col gap-2">
			<div className="flex items-center gap-2 font-mono leading-3.5">
				<span className="text-[10.5px] uppercase tracking-[0.07em] text-muted-foreground/80">
					{label}
				</span>
				<span className="truncate text-[10.5px] text-muted-foreground/50">
					{[attribute, note, bytes > 0 ? formatBytes(bytes) : undefined]
						.filter((part) => part !== undefined)
						.join(" · ")}
				</span>
			</div>
			<pre
				className={cn(
					"overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-sidebar px-3.5 py-3 font-mono text-xs leading-[18px] text-foreground/85",
					failed ? "border-[var(--severity-error)]/25" : "border-border",
				)}
			>
				{body === "" ? <span className="text-muted-foreground">not captured</span> : body}
			</pre>
		</div>
	)
}

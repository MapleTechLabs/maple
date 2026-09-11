import { useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { Dialog, DialogPopup } from "@maple/ui/components/ui/dialog"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import {
	CheckIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	ExternalLinkIcon,
	LinkIcon,
	XmarkIcon,
} from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { sessionRowId } from "@/lib/agent-sessions/session-window"
import {
	formatDurationNs,
	formatToolCount,
	UNGROUPED_FINGERPRINT,
	type ToolErrorBreakdownRow,
	type ToolErrorOccurrenceRow,
	type ToolErrorSessionRow,
	type ToolErrorVariantRow,
} from "@/lib/agent-sessions/tool-analytics"
import {
	errorTextTokens,
	errorTrendBucket,
	failureStatus,
	parsePayload,
	payloadLines,
	payloadLinesBytes,
	unwrapToolErrorText,
	variantDifferences,
	whatsWrong,
	type PayloadLine,
	type VariantDifference,
} from "@/lib/agent-sessions/tool-error-display"

import { ErrorTextHeading, FailureStatusLine, TrendBars, windowRangeLabel } from "./tool-error-parts"
import type { PreparedToolError, ToolErrorsWindow } from "./tool-errors-table"

/** One group's facts, read once per group — they do not page. */
export interface ToolErrorDetailData {
	readonly sessions: ReadonlyArray<ToolErrorSessionRow>
	readonly variants: ReadonlyArray<ToolErrorVariantRow>
	readonly breakdown: ReadonlyArray<ToolErrorBreakdownRow>
}

/** The group's samples as loaded so far, and what the list's footer offers. */
export interface ToolErrorSamplesState {
	readonly occurrences: ReadonlyArray<ToolErrorOccurrenceRow>
	/** The first page has not answered. */
	readonly loading: boolean
	/** The first page failed. */
	readonly failure?: unknown
	readonly paging: "more" | "loading" | "failed" | "end"
	readonly onLoadMore: () => void
}

/** The read's own page size — what "Load N more" promises. */
const SAMPLES_PAGE = 25

/** A key press the modal's shortcuts should leave alone. */
const typing = (event: KeyboardEvent) =>
	event.metaKey ||
	event.ctrlKey ||
	event.altKey ||
	(event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']") !== null)

/** Listens on the window for as long as the component is mounted. */
function useWindowKeydown(handler: (event: KeyboardEvent) => void) {
	const onKeyDown = useEffectEvent(handler)
	useMountEffect(() => {
		const listener = (event: KeyboardEvent) => onKeyDown(event)
		window.addEventListener("keydown", listener)
		return () => window.removeEventListener("keydown", listener)
	})
}

/**
 * One error group of one tool, in full: how it trends and whether it stopped,
 * where it happens, which sessions hit it, which raw texts it folded, and the
 * failed calls themselves — with the arguments that explain them.
 *
 * A modal rather than a route of its own because it is a reading of the row
 * behind it — closing it puts the reader back in the ranked list they were
 * scanning, and ↑/↓ reads the next row without closing anything. The group
 * stays in the URL regardless, so the reading is still linkable.
 *
 * The rail's selections — a session, a variant — narrow the samples and never
 * the rail itself, so a different one is always a click away.
 */
export function ToolErrorModal({
	tool,
	group,
	position,
	detail,
	detailLoading,
	detailFailure,
	samples,
	toolFailures,
	toolCalls,
	range,
	session,
	onSelectSession,
	variant,
	onSelectVariant,
	onStep,
	onClose,
}: {
	tool: string
	/** The row the modal was opened from — its totals are the header's. */
	group: PreparedToolError
	/** Where the group sits in the table, for "1 of 7" and ↑/↓. */
	position: { readonly index: number; readonly total: number }
	detail: ToolErrorDetailData
	detailLoading?: boolean
	/** The facts read failed. The header still stands — it came from the row. */
	detailFailure?: unknown
	samples: ToolErrorSamplesState
	/** Every failed call of this tool, for the "N% of failures" fact. */
	toolFailures: number
	/** The tool's calls in the window, which "stopped" is weighed against. */
	toolCalls: number
	range: ToolErrorsWindow
	session: string | undefined
	onSelectSession: (session: string | undefined) => void
	/** The raw text the samples are narrowed to. */
	variant: string | undefined
	onSelectVariant: (variant: string | undefined) => void
	/** Open the group above (-1) or below (+1) in the table. */
	onStep: (offset: -1 | 1) => void
	onClose: () => void
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const [linkCopy, setLinkCopy] = useState<"idle" | "copied" | "failed">("idle")
	const text = unwrapToolErrorText(group.message).text
	const tokens = useMemo(() => errorTextTokens(text), [text])
	const bucket = errorTrendBucket(range.startMs, range.endMs)
	const status = failureStatus({
		lastSeen: group.lastSeen,
		callsSince: group.callsSince,
		failures: group.calls,
		calls: toolCalls,
		nowMs: Date.now(),
	})
	const differences = useMemo(() => {
		const found = variantDifferences(detail.variants.map((row) => unwrapToolErrorText(row.message).text))
		return new Map(detail.variants.map((row, index) => [row.message, found[index]!] as const))
	}, [detail.variants])

	const share = toolFailures > 0 ? Math.round((group.calls / toolFailures) * 100) : 0
	const samplesTotal =
		variant !== undefined && session === undefined
			? (detail.variants.find((row) => row.message === variant)?.calls ?? samples.occurrences.length)
			: session !== undefined && variant === undefined
				? (detail.sessions.find((row) => row.sessionId === session)?.hits ?? samples.occurrences.length)
				: variant === undefined
					? group.calls
					: samples.occurrences.length

	useWindowKeydown((event) => {
		if (typing(event)) return
		if (event.key === "ArrowUp" && position.index > 0) {
			event.preventDefault()
			onStep(-1)
		} else if (event.key === "ArrowDown" && position.index < position.total - 1) {
			event.preventDefault()
			onStep(1)
		}
	})

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
					<header className="flex shrink-0 items-start gap-8 border-b border-border px-6 pt-5 pb-[18px] max-lg:flex-col max-lg:gap-4">
						<div className="flex min-w-0 flex-1 flex-col gap-2.5">
							<div className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] leading-3.5 text-muted-foreground/80">
								<span>{tool}</span>
								<span className="text-muted-foreground/40">/</span>
								<span>errors</span>
								<span className="text-muted-foreground/40">/</span>
								<span>
									{position.index + 1} of {position.total}
								</span>
								{group.errorType === "" ? null : (
									<span className="ml-1 rounded-sm border border-border px-[5px] text-[10.5px] text-muted-foreground/70">
										error.type {group.errorType}
									</span>
								)}
							</div>
							{group.fingerprint === UNGROUPED_FINGERPRINT ? (
								<div className="flex flex-col gap-1">
									<h2 className="font-mono text-lg leading-[26px] font-semibold tracking-[-0.01em] text-muted-foreground">
										Failures recorded before error grouping
									</h2>
									<p className="max-w-[90ch] font-mono text-xs leading-[17px] text-muted-foreground">
										These calls failed before Maple kept a failure's text, so they cannot be told apart by
										what they said. They leave this list as raw retention ages them out.
									</p>
								</div>
							) : text === "" ? (
								<h2 className="font-mono text-lg leading-[26px] font-semibold tracking-[-0.01em] text-muted-foreground">
									No error message recorded
								</h2>
							) : (
								<ErrorTextHeading tokens={tokens} />
							)}
							<div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-1 font-mono text-[11.5px] leading-3.5">
								<Facts
									items={[
										<span key="calls" className="text-foreground">
											{formatToolCount(group.calls)} failed call{group.calls === 1 ? "" : "s"}
										</span>,
										`${share}% of failures`,
										`${formatToolCount(group.sessions)} session${group.sessions === 1 ? "" : "s"}`,
										`first seen ${formatTimestampInTimezone(group.firstSeen, { timeZone: effectiveTimezone })}`,
										`last seen ${formatTimestampInTimezone(group.lastSeen, { timeZone: effectiveTimezone })}`,
									]}
								/>
							</div>
						</div>

						<div className="flex w-[340px] shrink-0 flex-col items-end gap-3.5 max-lg:items-start">
							<div className="flex items-center gap-2">
								<IconButton label="Previous error" disabled={position.index === 0} onClick={() => onStep(-1)}>
									<ChevronUpIcon size={12} aria-hidden />
								</IconButton>
								<IconButton
									label="Next error"
									disabled={position.index >= position.total - 1}
									onClick={() => onStep(1)}
								>
									<ChevronDownIcon size={12} aria-hidden />
								</IconButton>
								<IconButton
									label={
										linkCopy === "failed" ? "Copy failed" : linkCopy === "copied" ? "Link copied" : "Copy link"
									}
									onClick={() => {
										void navigator.clipboard.writeText(window.location.href).then(
											() => setLinkCopy("copied"),
											() => setLinkCopy("failed"),
										)
									}}
								>
									{linkCopy === "copied" ? <CheckIcon size={12} aria-hidden /> : <LinkIcon size={12} aria-hidden />}
								</IconButton>
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
								<IconButton label="Close" onClick={onClose}>
									<XmarkIcon size={12} aria-hidden />
								</IconButton>
							</div>
							<div className="flex w-[340px] flex-col gap-1.5">
								<div className="flex items-baseline justify-between font-mono">
									<span className="text-[10.5px] uppercase leading-3.5 tracking-[0.07em] text-muted-foreground/80">
										Failed calls / {bucket.unit}
									</span>
									<span className="text-[11px] leading-3.5 tabular-nums text-muted-foreground/70">
										max {formatToolCount(Math.max(0, ...group.spark))}
									</span>
								</div>
								<TrendBars counts={group.spark} width={340} height={44} radius={2} />
								<div className="flex justify-between font-mono text-[10.5px] leading-3.5 text-muted-foreground/70">
									<span>{windowRangeLabel(range.startMs, range.startMs, effectiveTimezone)}</span>
									<span>{windowRangeLabel(range.endMs, range.endMs, effectiveTimezone)}</span>
								</div>
								<FailureStatusLine
									status={status}
									scope="group"
									timeZone={effectiveTimezone}
									calls={toolCalls}
									failures={group.calls}
									activeBuckets={{
										active: group.spark.filter((count) => count > 0).length,
										total: group.spark.length,
										unit: bucket.unit,
									}}
									className="justify-end pt-0.5"
								/>
							</div>
						</div>
					</header>

					<div className="flex min-h-0 grow max-md:flex-col">
						<aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-border bg-sidebar max-md:h-56 max-md:w-full max-md:border-r-0 max-md:border-b">
							{detailFailure !== undefined ? (
								<QueryErrorState error={detailFailure} titleOverride="Failed to load this error's details" />
							) : (
								<>
									{detail.variants.length > 1 ? (
										<VariantsSection
											rows={detail.variants}
											total={group.variants}
											differences={differences}
											selected={variant}
											onSelect={onSelectVariant}
										/>
									) : null}
									<WhereItHappens rows={detail.breakdown} loading={detailLoading} />
									<SessionsSection
										tool={tool}
										rows={detail.sessions}
										total={group.sessions}
										calls={group.calls}
										lastSeen={group.lastSeen}
										selected={session}
										onSelect={onSelectSession}
										loading={detailLoading}
									/>
								</>
							)}
						</aside>
						{/* Keyed by the narrowing: a different list opens on its first sample. */}
						<SamplesPane
							key={`${group.fingerprint} ${session ?? ""} ${variant ?? ""}`}
							tool={tool}
							samples={samples}
							total={samplesTotal}
							differences={detail.variants.length > 1 ? differences : undefined}
						/>
					</div>
				</div>
			</DialogPopup>
		</Dialog>
	)
}

function Facts({ items }: { items: ReadonlyArray<ReactNode> }) {
	return (
		<>
			{items.map((item, index) => (
				<span key={index} className="contents">
					{index > 0 ? (
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
					) : null}
					{typeof item === "string" ? <span className="text-muted-foreground">{item}</span> : item}
				</span>
			))}
		</>
	)
}

function IconButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string
	disabled?: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
		>
			{children}
		</button>
	)
}

const railTitle = "font-mono text-[12.5px] font-medium text-foreground"
const railLabel = "font-mono text-[10.5px] uppercase leading-3.5 tracking-[0.07em] text-muted-foreground/80"

/** The raw texts a group folded, where there is more than one. Picking one
 *  narrows the samples to it. */
function VariantsSection({
	rows,
	total,
	differences,
	selected,
	onSelect,
}: {
	rows: ReadonlyArray<ToolErrorVariantRow>
	total: number
	differences: ReadonlyMap<string, VariantDifference>
	selected: string | undefined
	onSelect: (variant: string | undefined) => void
}) {
	const max = Math.max(1, ...rows.map((row) => row.calls))
	const onlyIndex = [...differences.values()].every((difference) => /^\[\d+\]$/.test(difference.middle))
	return (
		<section className="flex flex-col gap-2 border-b border-border p-4">
			<div className="flex items-baseline gap-2 pb-1">
				<span className={railTitle}>Variants</span>
				<span className="font-mono text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
					{formatToolCount(total)} raw messages
				</span>
			</div>
			{rows.map((row) => {
				const difference = differences.get(row.message)
				const isSelected = row.message === selected
				return (
					<button
						key={row.message}
						type="button"
						aria-pressed={isSelected}
						onClick={() => onSelect(isSelected ? undefined : row.message)}
						title={unwrapToolErrorText(row.message).text}
						className={cn(
							"-mx-2 flex h-[30px] shrink-0 items-center gap-2.5 rounded-md px-2 text-left font-mono text-xs transition-colors",
							isSelected ? "bg-primary/10" : "hover:bg-muted/40",
						)}
					>
						<span className="flex w-0 min-w-0 flex-1 items-baseline overflow-hidden whitespace-pre">
							{difference === undefined || difference.middle === "" ? (
								<span className="truncate text-muted-foreground">{unwrapToolErrorText(row.message).text}</span>
							) : (
								<>
									<span className="min-w-0 truncate whitespace-pre text-muted-foreground">
										{difference.before}
									</span>
									<span className="shrink-0 whitespace-pre font-medium text-foreground">{difference.middle}</span>
									<span className="min-w-0 truncate whitespace-pre text-muted-foreground">
										{difference.after}
									</span>
								</>
							)}
						</span>
						<span className="h-1 w-12 shrink-0 overflow-hidden rounded-[2px] bg-muted">
							<span
								className="block h-full bg-[var(--severity-error)]"
								style={{ width: `${Math.max(4, (row.calls / max) * 100)}%` }}
							/>
						</span>
						<span className="w-7 shrink-0 text-right tabular-nums text-foreground">{formatToolCount(row.calls)}</span>
					</button>
				)
			})}
			<p className="pt-1 font-mono text-[11px] leading-[15px] text-muted-foreground/70">
				{onlyIndex
					? "Grouped because only the array index differs."
					: "Grouped because only masked values differ."}{" "}
				Select one to filter samples.
			</p>
		</section>
	)
}

/** Which models and services the group's failures ran under — "is it one
 *  model?" — folded from the read's pairs, whose counts add. */
function WhereItHappens({ rows, loading }: { rows: ReadonlyArray<ToolErrorBreakdownRow>; loading?: boolean }) {
	const fold = (keyOf: (row: ToolErrorBreakdownRow) => string) => {
		const totals = new Map<string, number>()
		for (const row of rows) totals.set(keyOf(row), (totals.get(keyOf(row)) ?? 0) + row.calls)
		return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
	}
	return (
		<section className="flex flex-col gap-3.5 border-b border-border px-4 pt-4 pb-[18px]">
			<span className={railTitle}>Where it happens</span>
			{loading && rows.length === 0 ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3 w-3/4" />
					<Skeleton className="h-3 w-1/2" />
				</div>
			) : (
				<>
					<Breakdown label="Model" rows={fold((row) => row.model)} blank="unattributed" />
					<Breakdown label="Service" rows={fold((row) => row.service)} blank="unknown" />
				</>
			)}
		</section>
	)
}

function Breakdown({
	label,
	rows,
	blank,
}: {
	label: string
	rows: ReadonlyArray<readonly [string, number]>
	blank: string
}) {
	const max = rows[0]?.[1] ?? 1
	return (
		<div className="flex flex-col gap-1.5">
			<span className={railLabel}>{label}</span>
			{rows.map(([key, calls], index) => (
				<div key={key} className="flex items-center gap-2.5 font-mono text-xs leading-4">
					<span
						className={cn(
							"w-0 min-w-0 flex-1 truncate",
							index === 0 ? "text-foreground" : "text-muted-foreground",
							key === "" && "italic",
						)}
					>
						{key === "" ? blank : key}
					</span>
					<span className="h-1 w-14 shrink-0 overflow-hidden rounded-[2px] bg-muted">
						<span
							className="block h-full bg-muted-foreground"
							style={{ width: `${Math.max(4, (calls / max) * 100)}%` }}
						/>
					</span>
					<span
						className={cn(
							"w-10 shrink-0 text-right tabular-nums",
							index === 0 ? "text-foreground" : "text-muted-foreground",
						)}
					>
						{formatToolCount(calls)}
					</span>
				</div>
			))}
		</div>
	)
}

/**
 * The session a failure belongs to, linking to it: the trace view, filtered to
 * this tool, as the tool page's own sessions list opens it.
 *
 * No `t`/`end`, unlike that list: its rows carry the session's bounds, and these
 * carry only the failures'. The detail page reads a window hint AS the window,
 * so the failures' extent would cut every session that ran on past them; left
 * off, the page resolves the session's true bounds once and stamps them.
 *
 * Positioned, so it sits above a row's stretched button: an anchor inside a
 * button is invalid nesting.
 */
function SessionLink({
	tool,
	sessionId,
	spanId,
	className,
}: {
	tool: string
	sessionId: string
	/** The failed call, opened in the detail page's span panel. */
	spanId?: string
	className?: string
}) {
	return (
		<Link
			to="/agent-sessions/$sessionId"
			params={{ sessionId }}
			search={{ tool, view: "trace", ...(spanId !== undefined && { span: spanId }) }}
			title={sessionId}
			className={cn(
				"group/link relative flex min-w-0 items-center gap-1.5 rounded-sm text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		>
			<span className="truncate">{sessionRowId(sessionId)}</span>
			<ExternalLinkIcon size={10} className="shrink-0 text-muted-foreground" aria-hidden />
		</Link>
	)
}

/** Which sessions hit this group, and how hard. `All sessions` is the way back
 *  out of a selection, and is what the rail opens on. */
function SessionsSection({
	tool,
	rows,
	total,
	calls,
	lastSeen,
	selected,
	onSelect,
	loading,
}: {
	tool: string
	rows: ReadonlyArray<ToolErrorSessionRow>
	total: number
	calls: number
	lastSeen: number
	selected: string | undefined
	onSelect: (session: string | undefined) => void
	loading?: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const relative = (ms: number) => formatRelativeTimeOrDate(ms, undefined, effectiveTimezone)
	const rowClass = (isSelected: boolean) =>
		cn(
			"group relative flex w-full shrink-0 items-center gap-3 border-b border-l-2 border-border/50 pr-4 pl-3.5 text-left transition-colors",
			isSelected ? "border-l-primary bg-primary/10" : "border-l-transparent hover:bg-muted/30",
		)

	return (
		<section className="flex flex-col">
			<div className="flex items-baseline gap-2 px-4 pt-4 pb-2.5">
				<span className={railTitle}>Sessions</span>
				<span className="font-mono text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
					{formatToolCount(total)}
				</span>
			</div>
			<div className={cn("flex h-[30px] shrink-0 items-center gap-3 border-y border-border px-4", railLabel)}>
				<span className="grow">Session</span>
				<span className="w-10 shrink-0 text-right">Hits</span>
				<span className="w-14 shrink-0 text-right">Last</span>
			</div>
			<button
				type="button"
				aria-pressed={selected === undefined}
				onClick={() => onSelect(undefined)}
				className={cn(rowClass(selected === undefined), "h-10")}
			>
				<span className="grow font-mono text-[12.5px] font-medium text-foreground">All sessions</span>
				<span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
					{formatToolCount(calls)}
				</span>
				<span className="w-14 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70">
					{relative(lastSeen)}
				</span>
			</button>
			{loading && rows.length === 0 ? (
				<div className="flex flex-col gap-1.5 px-4 py-3">
					<Skeleton className="h-10" />
					<Skeleton className="h-10" />
				</div>
			) : (
				rows.map((row) => {
					const isSelected = row.sessionId === selected
					return (
						<div key={row.sessionId} className={cn(rowClass(isSelected), "h-[52px]")}>
							{/* Stretched under the row: a click anywhere but the id narrows
							    the samples to this session. */}
							<button
								type="button"
								aria-pressed={isSelected}
								aria-label={`Show samples in ${sessionRowId(row.sessionId)}`}
								onClick={() => onSelect(isSelected ? undefined : row.sessionId)}
								className="absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
							/>
							<span className="flex w-0 min-w-0 grow flex-col items-start gap-[3px]">
								<SessionLink tool={tool} sessionId={row.sessionId} className="max-w-full font-mono text-xs" />
								<span className="w-full truncate font-mono text-[11px] leading-3.5 text-muted-foreground/70">
									{row.service === "" ? (row.agentName === "" ? row.vendorId : row.agentName) : row.service}
								</span>
							</span>
							<span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
								{formatToolCount(row.hits)}
							</span>
							<span className="w-14 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70">
								{relative(row.lastSeen)}
							</span>
						</div>
					)
				})
			)}
			<div className="flex h-9 shrink-0 items-center gap-[9px] px-4 font-mono text-xs">
				<span className="text-muted-foreground">
					Showing {formatToolCount(rows.length)} of {formatToolCount(total)}
				</span>
				<span className="text-muted-foreground/60">by hits</span>
			</div>
		</section>
	)
}

/**
 * The failed calls themselves, newest first. One is open at a time — the first,
 * because a modal that opens onto collapsed rows makes the reader click to see
 * the thing they asked for — and j/k move it, loading the next page at the end.
 */
function SamplesPane({
	tool,
	samples,
	total,
	differences,
}: {
	tool: string
	samples: ToolErrorSamplesState
	total: number
	/** Present where the group has variants, to label each sample with its own. */
	differences: ReadonlyMap<string, VariantDifference> | undefined
}) {
	const rows = samples.occurrences
	const [selected, setSelected] = useState(0)
	const [closed, setClosed] = useState(false)
	const rowRefs = useRef(new Map<number, HTMLElement>())
	const current = Math.min(selected, Math.max(rows.length - 1, 0))

	const select = (index: number) => {
		if (index < 0) return
		if (index >= rows.length) {
			if (samples.paging === "more") samples.onLoadMore()
			return
		}
		setSelected(index)
		setClosed(false)
		rowRefs.current.get(index)?.scrollIntoView({ block: "nearest" })
	}

	useWindowKeydown((event) => {
		if (typing(event)) return
		if (event.key === "j") select(current + 1)
		else if (event.key === "k") select(current - 1)
	})

	return (
		<div className="flex min-w-0 grow flex-col overflow-hidden">
			<div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-6 font-mono">
				<div className="flex items-baseline gap-2">
					<span className="text-[12.5px] font-medium text-foreground">Samples</span>
					<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
						{formatToolCount(total)} failed call{total === 1 ? "" : "s"} · newest first
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="pr-1 text-[11px] text-muted-foreground/60 max-md:hidden">j / k</span>
					<button
						type="button"
						aria-label="Newer sample"
						disabled={current === 0}
						onClick={() => select(current - 1)}
						className="inline-flex size-[26px] items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
					>
						<ChevronLeftIcon size={12} aria-hidden />
					</button>
					<span className="w-[72px] text-center text-xs tabular-nums text-foreground">
						{rows.length === 0 ? 0 : current + 1} of {formatToolCount(total)}
					</span>
					<button
						type="button"
						aria-label="Older sample"
						disabled={current >= rows.length - 1 && samples.paging !== "more"}
						onClick={() => select(current + 1)}
						className="inline-flex size-[26px] items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
					>
						<ChevronRightIcon size={12} aria-hidden />
					</button>
				</div>
			</div>

			<div className="min-h-0 grow overflow-y-auto overscroll-contain">
				{samples.failure !== undefined ? (
					<QueryErrorState error={samples.failure} titleOverride="Failed to load samples" />
				) : samples.loading && rows.length === 0 ? (
					<div className="flex flex-col gap-1.5 px-6 py-3">
						<Skeleton className="h-10" />
						<Skeleton className="h-10" />
						<Skeleton className="h-10" />
					</div>
				) : rows.length === 0 ? (
					<div className="px-6 py-12 text-center font-mono text-xs text-muted-foreground">
						No samples in the selected window.
					</div>
				) : (
					rows.map((row, index) => (
						<Sample
							key={row.spanId}
							tool={tool}
							row={row}
							open={index === current && !closed}
							onToggle={() => {
								if (index === current) setClosed((wasClosed) => !wasClosed)
								else select(index)
							}}
							register={(element) => {
								if (element === null) rowRefs.current.delete(index)
								else rowRefs.current.set(index, element)
							}}
							variant={differences?.get(row.message)?.middle}
						/>
					))
				)}

				{rows.length > 0 ? (
					<div className="flex h-9 items-center gap-[9px] px-6 font-mono text-xs">
						<span className="text-muted-foreground">
							Showing {formatToolCount(rows.length)} of {formatToolCount(total)}
						</span>
						{samples.paging === "more" ? (
							<button
								type="button"
								onClick={samples.onLoadMore}
								className="text-foreground transition-colors hover:text-primary"
							>
								Load {Math.min(SAMPLES_PAGE, Math.max(total - rows.length, 1))} more
							</button>
						) : samples.paging === "loading" ? (
							<span className="text-muted-foreground/60">Loading…</span>
						) : samples.paging === "failed" ? (
							<button
								type="button"
								onClick={samples.onLoadMore}
								className="text-[var(--severity-error)] transition-colors hover:text-foreground"
							>
								Couldn't load more — retry
							</button>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	)
}

function Sample({
	tool,
	row,
	open,
	onToggle,
	register,
	variant,
}: {
	tool: string
	row: ToolErrorOccurrenceRow
	open: boolean
	onToggle: () => void
	register: (element: HTMLElement | null) => void
	/** The part of this call's text its variant differs by, e.g. `[0]`. */
	variant: string | undefined
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon
	const time = formatTimestampInTimezone(row.timestamp, { timeZone: effectiveTimezone })
	return (
		<div ref={register} className="border-b border-border/50">
			{/* The toggle is stretched under the row and the links sit above it, as
			    siblings: an anchor inside a button is invalid nesting. */}
			<div
				className={cn(
					"group relative flex w-full items-center gap-3.5 px-6 font-mono transition-colors hover:bg-muted/30",
					open ? "h-11" : "h-10",
				)}
			>
				<button
					type="button"
					aria-expanded={open}
					aria-label={`Sample at ${time}`}
					onClick={onToggle}
					className="absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
				/>
				<Chevron size={12} className="shrink-0 text-muted-foreground" aria-hidden />
				<span className="shrink-0 text-[12.5px] text-foreground">{time}</span>
				<span className="flex min-w-0 shrink items-center gap-[5px] text-xs">
					<span className="shrink-0 text-muted-foreground/70">session</span>
					<SessionLink tool={tool} sessionId={row.sessionId} spanId={row.spanId} className="max-w-[160px]" />
				</span>
				{/* Plain breakpoints, not container queries: the dialog is portalled out
				    of the page's container, so `@min-…/page` never matches here. */}
				<span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground lg:block">
					{row.model === "" ? "model not recorded" : row.model}
				</span>
				{row.service === "" ? null : (
					<span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground/70 xl:block">
						{row.service}
					</span>
				)}
				{variant === undefined || variant === "" ? null : (
					<span className="hidden shrink-0 rounded-sm border border-border px-[5px] text-[10.5px] leading-3.5 text-muted-foreground/70 md:block">
						variant <span className="text-foreground/85">{variant}</span>
					</span>
				)}
				<span className="grow" />
				{open || row.argumentsBytes === 0 ? null : (
					<span className="hidden shrink-0 text-[11.5px] tabular-nums text-muted-foreground/70 md:block">
						args {formatToolCount(row.argumentsBytes)} B
					</span>
				)}
				<span className="w-12 shrink-0 text-right text-xs tabular-nums text-foreground/85">
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

			{open ? <SampleBody row={row} /> : null}
		</div>
	)
}

/** What the call was handed and what it gave back — and, where the arguments
 *  confirm a schema failure, what is wrong with them in so many words. */
function SampleBody({ row }: { row: ToolErrorOccurrenceRow }) {
	const message = unwrapToolErrorText(row.message).text
	const args = useMemo(() => parsePayload(row.arguments), [row.arguments])
	const hint = whatsWrong(message, args)
	return (
		<div className="flex flex-col gap-3.5 pr-6 pb-5 pl-[50px]">
			{hint === undefined ? null : (
				<div className="flex items-baseline gap-3 rounded-md border border-[var(--severity-error)]/20 bg-[var(--severity-error)]/[0.07] px-3 py-[9px] font-mono">
					<span className="shrink-0 text-[10.5px] uppercase leading-4 tracking-[0.07em] text-[var(--severity-error)]">
						What's wrong
					</span>
					<span className="text-xs leading-4 text-foreground/85">
						<span className="font-medium text-foreground">{hint.subject}</span> {hint.text}
					</span>
				</div>
			)}
			{row.arguments === "" && row.result === "" ? (
				<div className="flex items-start gap-3 rounded-md border border-border bg-sidebar px-3.5 py-3 font-mono">
					<span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-muted-foreground" />
					<span className="flex flex-col gap-1">
						<span className="text-[12.5px] leading-4 text-foreground">The tool reported no error detail</span>
						<span className="text-xs leading-[17px] text-muted-foreground">
							This call recorded no arguments and no result, so the cause of the failure isn't in the
							telemetry — the message above is all the span carries.
						</span>
					</span>
				</div>
			) : null}
			<div className="flex items-start gap-4 max-lg:flex-col">
				<ArgumentsBlock row={row} message={message} args={args} />
				<ResultBlock row={row} />
			</div>
		</div>
	)
}

function PayloadHead({ label, attribute, bytes, action }: { label: string; attribute: string; bytes: number; action?: ReactNode }) {
	return (
		<div className="flex items-center gap-2 font-mono leading-3.5">
			<span className="text-[10.5px] uppercase tracking-[0.07em] text-muted-foreground/80">{label}</span>
			<span className="truncate text-[10.5px] text-muted-foreground/50">
				{attribute}
				{bytes > 0 ? ` · ${formatToolCount(bytes)} B` : null}
			</span>
			<span className="grow" />
			{action}
		</div>
	)
}

function NotRecorded({ what }: { what: "arguments" | "result" }) {
	return (
		<div className="flex flex-col gap-1 rounded-md border border-dashed border-input p-3.5 font-mono">
			<span className="text-xs text-muted-foreground">Not recorded</span>
			<span className="text-[11px] leading-[15px] text-muted-foreground/70">The span has no {what} attribute.</span>
		</div>
	)
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length

/**
 * The arguments, shortened around the error path: the value it names
 * highlighted (or, for a missing key, the object that lacks it), the siblings
 * it runs past folded, long strings cut. "Show full payload" is everything the
 * read carries.
 */
function ArgumentsBlock({ row, message, args }: { row: ToolErrorOccurrenceRow; message: string; args: unknown }) {
	const [full, setFull] = useState(false)
	// `writeText` rejects outside a secure context or without the clipboard
	// permission; the button says so rather than staying silent.
	const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle")
	const lines = useMemo(() => (args === undefined ? undefined : payloadLines(args, message)), [args, message])
	if (row.arguments === "") {
		return (
			<div className="flex w-0 min-w-0 grow flex-col gap-2 max-lg:w-full">
				<PayloadHead label="Arguments" attribute="gen_ai.tool.call.arguments" bytes={0} />
				<NotRecorded what="arguments" />
			</div>
		)
	}
	const truncatedByRead = row.argumentsBytes > utf8Length(row.arguments)
	return (
		<div className="flex w-0 min-w-0 grow flex-col gap-2 max-lg:w-full">
			<PayloadHead
				label="Arguments"
				attribute="gen_ai.tool.call.arguments"
				bytes={row.argumentsBytes}
				action={
					<button
						type="button"
						onClick={() =>
							void navigator.clipboard.writeText(row.arguments).then(
								() => setCopy("copied"),
								() => setCopy("failed"),
							)
						}
						className="font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					>
						{copy === "failed" ? "Copy failed" : copy === "copied" ? "Copied" : "Copy"}
					</button>
				}
			/>
			{lines === undefined || full ? (
				<pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-sidebar px-3.5 py-3 font-mono text-xs leading-[18px] text-foreground/85">
					{args === undefined ? row.arguments : JSON.stringify(args, null, 2)}
				</pre>
			) : (
				<div className="flex flex-col overflow-x-auto rounded-md border border-border bg-sidebar py-3 font-mono text-xs leading-[18px]">
					{lines.map((line, index) => (
						<PayloadLineView key={index} line={line} />
					))}
				</div>
			)}
			<div className="flex items-center gap-2.5 font-mono text-[11px] leading-3.5 text-muted-foreground/70">
				<span>
					{truncatedByRead
						? `The first ${formatToolCount(row.arguments.length)} characters of ${formatToolCount(row.argumentsBytes)} B`
						: lines !== undefined && !full
							? `Showing ${formatToolCount(Math.min(payloadLinesBytes(lines), row.argumentsBytes))} of ${formatToolCount(row.argumentsBytes)} B · long strings shortened around the error path`
							: null}
				</span>
				<span className="grow" />
				{lines === undefined ? null : (
					<button
						type="button"
						onClick={() => setFull((showing) => !showing)}
						className="flex h-6 shrink-0 items-center rounded-md border border-border bg-card px-2 text-foreground transition-colors hover:bg-muted/50"
					>
						{full ? "Shorten" : "Show full payload"}
					</button>
				)}
			</div>
		</div>
	)
}

function PayloadLineView({ line }: { line: PayloadLine }) {
	return (
		<div
			className={cn(
				"pr-3.5",
				line.highlight && "border-l-2 border-l-[var(--severity-error)] bg-[var(--severity-error)]/10",
			)}
			style={{ paddingLeft: 14 + line.depth * 16 - (line.highlight ? 2 : 0) }}
		>
			{line.missingKey !== undefined ? (
				<span className="my-0.5 inline-flex items-center gap-2 rounded-[3px] border border-dashed border-[var(--severity-error)]/60 px-1.5 text-[11px] leading-4 text-[var(--severity-error)]">
					"{line.missingKey}"<span className="opacity-80">missing, required</span>
				</span>
			) : (
				<span
					className={cn(
						"whitespace-pre-wrap break-words",
						line.highlight ? "text-foreground" : line.folded !== undefined ? "text-muted-foreground" : "text-foreground/85",
					)}
				>
					{line.text}
				</span>
			)}
			{line.folded === undefined ? null : (
				<span className="ml-2 rounded-[3px] bg-muted px-1 text-[10.5px] text-muted-foreground">{line.folded}</span>
			)}
			{line.note === undefined ? null : (
				<div className="flex items-center gap-2.5 pb-1 text-[11px] leading-3.5">
					<span className="text-[var(--severity-error)]">↑ {line.note.text}</span>
					{line.note.hiddenBytes > 0 ? (
						<span className="rounded-[3px] bg-muted px-1 text-[10.5px] text-muted-foreground">
							+{formatToolCount(line.note.hiddenBytes)} B not shown
						</span>
					) : null}
				</div>
			)}
		</div>
	)
}

function ResultBlock({ row }: { row: ToolErrorOccurrenceRow }) {
	const parsed = useMemo(() => parsePayload(row.result), [row.result])
	const source = unwrapToolErrorText(row.result).source
	return (
		<div className="flex w-[320px] shrink-0 flex-col gap-2 max-lg:w-full">
			<PayloadHead label="Result" attribute="gen_ai.tool.call.result" bytes={row.resultBytes} />
			{row.result === "" ? (
				<NotRecorded what="result" />
			) : (
				<pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--severity-error)]/25 bg-sidebar px-3.5 py-3 font-mono text-xs leading-[18px] text-foreground/85">
					{parsed === undefined ? row.result : JSON.stringify(parsed, null, 2)}
				</pre>
			)}
			{source === undefined ? null : (
				<span className="font-mono text-[11px] leading-3.5 text-muted-foreground/70">
					Error message read from {source}
				</span>
			)}
		</div>
	)
}

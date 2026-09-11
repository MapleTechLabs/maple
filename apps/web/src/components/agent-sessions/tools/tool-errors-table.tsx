import { useMemo, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { useTableSort } from "@/components/infra/primitives/data-table"
import { QueryErrorState } from "@/components/common/query-error-state"
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	formatToolCount,
	UNGROUPED_FINGERPRINT,
	type ToolErrorRow,
} from "@/lib/agent-sessions/tool-analytics"
import {
	commonErrorPrefix,
	errorTextTokens,
	errorTrendBucket,
	failureStatus,
	fillTrend,
	unwrapToolErrorText,
	type ErrorTextToken,
} from "@/lib/agent-sessions/tool-error-display"

import { ROW, ROW_IDLE, ROW_SELECTED, ShareCell, Table, TableBody, TableHead, Th } from "./tool-breakdown-tables"
import { ErrorTextLine, FailureStatusLine, MaskChip, TrendBars, windowRangeLabel } from "./tool-error-parts"

type ErrorSortKey = "calls" | "sessions" | "lastSeen"

/** Groups shown before the long tail folds behind "Show N more errors". */
const VISIBLE_GROUPS = 10

/** What each placeholder stands for, in the legend under the table. */
const MASK_MEANINGS = new Map([
	["[*]", "index"],
	["<n>", "number"],
	["<ts>", "timestamp"],
	["<id>", "id"],
	["<email>", "email"],
	["<url>", "host"],
])

/** A window the table reads its trend and its status over. */
export interface ToolErrorsWindow {
	readonly startMs: number
	readonly endMs: number
}

/** A group as the row draws it: its message without the hoisted prefix, as
 *  tokens, and its trend over every bucket of the window. */
export interface PreparedToolError extends ToolErrorRow {
	readonly tokens: ReadonlyArray<ErrorTextToken>
	readonly display: string
	readonly share: number
	readonly spark: ReadonlyArray<number>
}

/**
 * The rows, as the table and the modal both read them: every group's message
 * unwrapped from its result envelope, the prefix every group shares cut off
 * (the table's head states it once), and its trend filled over the window.
 */
export function prepareToolErrors(
	rows: ReadonlyArray<ToolErrorRow>,
	window: ToolErrorsWindow,
): { readonly rows: ReadonlyArray<PreparedToolError>; readonly prefix: string; readonly errorType?: string } {
	const failures = rows.reduce((sum, row) => sum + row.calls, 0)
	const bucket = errorTrendBucket(window.startMs, window.endMs)
	const texts = rows.map((row) => unwrapToolErrorText(row.message).text)
	const prefix = commonErrorPrefix(
		texts.filter((text, index) => text !== "" && rows[index]!.fingerprint !== UNGROUPED_FINGERPRINT),
	)
	// The pre-grouping row names no type because it names nothing; it does not
	// stop the others' shared type from being the tool's.
	const types = new Set(rows.flatMap((row) => (row.fingerprint === UNGROUPED_FINGERPRINT ? [] : [row.errorType])))
	const [onlyType] = types
	return {
		prefix,
		// One type across several groups is a fact about the tool, not the row.
		...(rows.length > 1 && types.size === 1 && onlyType !== "" && { errorType: onlyType }),
		rows: rows.map((row, index) => {
			const text = texts[index]!
			const display = prefix !== "" && text.startsWith(prefix) ? text.slice(prefix.length) : text
			return {
				...row,
				display,
				tokens: errorTextTokens(display),
				share: failures > 0 ? row.calls / failures : 0,
				spark: fillTrend(row.trend, window.startMs, window.endMs, bucket.seconds),
			}
		}),
	}
}

const shareLabel = (share: number) => (share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`)

/**
 * How one tool fails, one row per distinct error — the tool detail page's
 * answer to the error rate above it.
 *
 * A row is an error GROUP: failures whose text differs only where the grouping
 * masks it (an array index, a number, an id). Its title is the group's latest
 * text with the prefix every group shares hoisted into the head, so a column of
 * "Invalid tool input: …" reads as the part that differs; the masked spans are
 * drawn as placeholders and "N variants" says how many texts a row folded.
 *
 * SHARE is of this tool's failures, not of its calls: the column is answering
 * "which failure should I fix first", and the rate against all calls is already
 * the tile at the top of the page.
 */
export function ToolErrorsTable({
	rows,
	tool,
	toolCalls,
	window,
	selected,
	onSelect,
	loading,
	failure,
	waiting,
}: {
	rows: ReadonlyArray<ToolErrorRow>
	tool: string
	/** The tool's calls in the window — what the header's rate and status read. */
	toolCalls: number
	window: ToolErrorsWindow
	/** The group a modal is open on, drawn as the selected row. */
	selected: string | undefined
	onSelect: (fingerprint: string) => void
	/** The read has not answered yet. Distinct from an empty result: "no failed
	 *  calls" is a finding, and a table that states it while still loading is
	 *  stating something it does not know. */
	loading?: boolean
	/** The read failed — the same distinction, from the other side. */
	failure?: unknown
	waiting?: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const [expanded, setExpanded] = useState(false)
	const failures = rows.reduce((sum, row) => sum + row.calls, 0)
	const prepared = useMemo(() => prepareToolErrors(rows, window), [rows, window])
	const maxShare = useMemo(
		() => prepared.rows.reduce((max, row) => Math.max(max, row.share), 0),
		[prepared],
	)
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(prepared.rows, {
		initialKey: "calls" as ErrorSortKey,
		stringKeys: [],
	})
	const visible = expanded ? sorted : sorted.slice(0, VISIBLE_GROUPS)
	const hidden = sorted.slice(VISIBLE_GROUPS)
	const hiddenCalls = hidden.reduce((sum, row) => sum + row.calls, 0)

	// The tool's own status: its newest failure of any group, and the calls
	// since that one — the fewest any group has.
	const status =
		rows.length === 0
			? undefined
			: failureStatus({
					lastSeen: Math.max(...rows.map((row) => row.lastSeen)),
					callsSince: Math.min(...rows.map((row) => row.callsSince)),
					failures,
					calls: toolCalls,
					nowMs: Date.now(),
				})

	const masks = [
		...new Set(
			visible.flatMap((row) =>
				row.tokens.flatMap((token) =>
					token.kind === "mask"
						? [token.label]
						: token.kind === "path"
							? token.parts.flatMap((part) => (part.kind === "mask" ? [part.label] : []))
							: [],
				),
			),
		),
	].filter((label) => MASK_MEANINGS.has(label))

	const headHint = [
		prepared.prefix === "" ? undefined : `all start “${prepared.prefix.trim()}”`,
		prepared.errorType === undefined ? undefined : `error.type ${prepared.errorType}`,
	]
		.filter((part) => part !== undefined)
		.join(" · ")

	const empty = !loading && failure === undefined && rows.length === 0

	return (
		<section className="@container/panel min-w-0 border-b border-border px-6 pt-5 pb-4" aria-label="Errors">
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-3 font-mono">
				<div className="flex items-baseline gap-2.5">
					<span className="text-[12.5px] font-medium text-foreground">Errors</span>
					{loading ? (
						<Skeleton className="h-2.5 w-[150px] self-center" />
					) : (
						<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
							{formatToolCount(failures)} failed call{failures === 1 ? "" : "s"}
							{rows.length > 0 ? ` · ${formatToolCount(rows.length)} error${rows.length === 1 ? "" : "s"}` : null}
						</span>
					)}
				</div>
				{status === undefined ? null : (
					<FailureStatusLine
						status={status}
						scope="tool"
						timeZone={effectiveTimezone}
						calls={toolCalls}
						failures={failures}
					/>
				)}
			</div>

			{empty ? (
				<div className="flex flex-col gap-2 border-t border-border px-2.5 pt-[22px] pb-5 font-mono">
					<span className="flex items-center gap-2 text-[12.5px] text-foreground">
						<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--severity-info)]" />
						No failed calls between {windowRangeLabel(window.startMs, window.startMs, effectiveTimezone)} and{" "}
						{windowRangeLabel(window.endMs, window.endMs, effectiveTimezone)}
					</span>
					<span className="pl-3.5 text-xs text-muted-foreground">
						{toolCalls > 0
							? `All ${formatToolCount(toolCalls)} ${tool} call${toolCalls === 1 ? "" : "s"} in this range succeeded.`
							: `${tool} was not called in this range.`}
					</span>
				</div>
			) : (
				<Table>
					<TableHead>
						<div className="flex w-0 min-w-0 flex-1 items-baseline gap-2.5 font-mono text-[10.5px] leading-3.5">
							<span className="uppercase tracking-[0.07em] text-muted-foreground/80">Error</span>
							{headHint === "" ? null : (
								<span className="truncate text-muted-foreground/60" title={headHint}>
									{headHint}
								</span>
							)}
						</div>
						<Th
							label={windowRangeLabel(window.startMs, window.endMs, effectiveTimezone)}
							width="w-[96px] shrink-0"
							hidden="hidden @min-[720px]/panel:flex"
						/>
						<Th label="Share" width="w-[150px] shrink-0 pl-6" />
						<Th<ErrorSortKey>
							label="Count"
							width="w-[76px] shrink-0"
							align="right"
							sortKey="calls"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						<Th<ErrorSortKey>
							label="Sessions"
							width="w-[76px] shrink-0"
							align="right"
							sortKey="sessions"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
							hidden="hidden @min-[640px]/panel:flex"
						/>
						<Th<ErrorSortKey>
							label="Last seen"
							width="w-[96px] shrink-0"
							align="right"
							sortKey="lastSeen"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
							hidden="hidden @min-[800px]/panel:flex"
						/>
						<span className="w-3.5 shrink-0" aria-hidden />
					</TableHead>

					<TableBody waiting={waiting} maxHeight={expanded ? 760 : 460}>
						{failure !== undefined ? (
							<QueryErrorState error={failure} titleOverride={`Failed to load ${tool} errors`} />
						) : loading ? (
							<LoadingRows />
						) : (
							<>
								{visible.map((row) => (
									<button
										key={row.fingerprint}
										type="button"
										aria-pressed={row.fingerprint === selected}
										onClick={() => onSelect(row.fingerprint)}
										className={cn(ROW, row.fingerprint === selected ? ROW_SELECTED : ROW_IDLE)}
										title={row.display === "" ? undefined : row.display}
									>
										<span className="flex w-0 min-w-0 flex-1 items-center gap-2.5 overflow-hidden font-mono text-[12.5px] leading-4">
											<GroupTitle row={row} />
											{prepared.errorType === undefined && row.errorType !== "" ? (
												<span className="flex h-[18px] shrink-0 items-center rounded-sm border border-border px-[5px] text-[11px] leading-3.5 text-[var(--severity-error)]">
													{row.errorType}
												</span>
											) : null}
											{row.variants > 1 ? (
												<span className="shrink-0 pl-1.5 text-[11px] leading-3.5 text-muted-foreground/70">
													{row.variants} variants
												</span>
											) : null}
										</span>
										<span className="hidden w-[96px] shrink-0 items-center @min-[720px]/panel:flex">
											<TrendBars counts={row.spark} width={92} height={16} />
										</span>
										<ShareCell
											ratio={row.share}
											max={maxShare}
											label={shareLabel(row.share)}
											tone={{ bar: "bg-[var(--severity-error)]", text: "text-muted-foreground" }}
										/>
										<span className="w-[76px] shrink-0 text-right font-mono text-[12.5px] tabular-nums text-foreground">
											{formatToolCount(row.calls)}
										</span>
										<span className="hidden w-[76px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @min-[640px]/panel:block">
											{formatToolCount(row.sessions)}
										</span>
										<span className="hidden w-[96px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70 @min-[800px]/panel:block">
											{formatRelativeTimeOrDate(row.lastSeen, undefined, effectiveTimezone)}
										</span>
										<span className="flex w-3.5 shrink-0 items-center justify-end text-muted-foreground/60">
											<ChevronRightIcon size={14} aria-hidden />
										</span>
									</button>
								))}
								{hidden.length > 0 ? (
									<button
										type="button"
										onClick={() => setExpanded((open) => !open)}
										aria-expanded={expanded}
										className="flex h-[38px] w-full items-center gap-2.5 px-2.5 text-left font-mono text-xs transition-colors hover:bg-muted/30"
									>
										<ChevronDownIcon
											size={12}
											className={cn("text-muted-foreground transition-transform", expanded && "rotate-180")}
											aria-hidden
										/>
										<span className="text-foreground">
											{expanded
												? "Show fewer errors"
												: `Show ${formatToolCount(hidden.length)} more error${hidden.length === 1 ? "" : "s"}`}
										</span>
										{expanded ? null : (
											<span className="text-muted-foreground/70">
												{formatToolCount(hiddenCalls)} failed call{hiddenCalls === 1 ? "" : "s"}
												{hiddenCalls === hidden.length && hidden.length > 1 ? ", 1 each" : null}
											</span>
										)}
									</button>
								) : null}
							</>
						)}
					</TableBody>

					{masks.length > 0 && !loading ? (
						<div className="flex flex-wrap items-center gap-2 border-t border-border px-2.5 pt-3 font-mono text-[11px] leading-3.5 text-muted-foreground/70">
							<span>Calls with the same message are grouped; changing values are masked:</span>
							{masks.map((label) => (
								<span key={label} className="flex items-center gap-1.5">
									<MaskChip label={label} raw="" className="text-[10.5px] leading-3.5" />
									<span>{MASK_MEANINGS.get(label)}</span>
								</span>
							))}
						</div>
					) : null}
				</Table>
			)}
		</section>
	)
}

/** The row's title: the group's message, or what it is where it has none. */
function GroupTitle({ row }: { row: PreparedToolError }) {
	if (row.fingerprint === UNGROUPED_FINGERPRINT) {
		return <span className="truncate text-muted-foreground">Failures recorded before error grouping</span>
	}
	if (row.display === "") {
		return <span className="truncate text-muted-foreground">No error message recorded</span>
	}
	return <ErrorTextLine tokens={row.tokens} />
}

/** The head and the lanes stay put; only the values are placeholders. */
function LoadingRows() {
	return (
		<>
			{[340, 260, 400].map((width, index) => (
				<div
					key={width}
					className="flex h-[38px] items-center gap-3 border-b border-border/50 px-2.5 last:border-0"
					style={{ opacity: 1 - index * 0.2 }}
				>
					<span className="w-0 min-w-0 flex-1">
						<Skeleton className="h-2.5" style={{ width, maxWidth: "100%" }} />
					</span>
					<span className="hidden w-[96px] shrink-0 @min-[720px]/panel:block">
						<Skeleton className="h-2.5 w-[92px]" />
					</span>
					<span className="flex w-[150px] shrink-0 justify-end gap-2.5">
						<Skeleton className="h-1 w-[60px]" />
						<span className="w-[46px]" />
					</span>
					<span className="flex w-[76px] shrink-0 justify-end">
						<Skeleton className="h-2.5 w-7" />
					</span>
					<span className="hidden w-[76px] shrink-0 justify-end @min-[640px]/panel:flex">
						<Skeleton className="h-2.5 w-[22px]" />
					</span>
					<span className="hidden w-[96px] shrink-0 justify-end @min-[800px]/panel:flex">
						<Skeleton className="h-2.5 w-11" />
					</span>
					<span className="w-3.5 shrink-0" />
				</div>
			))}
		</>
	)
}

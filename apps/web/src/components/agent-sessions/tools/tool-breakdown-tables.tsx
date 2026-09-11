import { useMemo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { QueryErrorState } from "@/components/common/query-error-state"
import { useTableSort, type SortDir } from "@/components/infra/primitives/data-table"
import { relativeRatio } from "@/components/infra/primitives/share-bar"
import { ArrowUpDownIcon, ChevronRightIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import type { ToolDetailLinkSearch } from "@/lib/agent-sessions/tool-search"
import {
	breakdownKeyLabel,
	errorRate,
	formatDurationNs,
	formatToolCount,
	toolBadges,
	toolsTableFooter,
	type ToolBadge,
	type ToolBreakdownRow,
	type ToolPercentile,
} from "@/lib/agent-sessions/tool-analytics"

/* -------------------------------------------------------------------------------------------------
 * Table chrome shared by every table on the tools pages
 *
 * Not the infra `DataTable`: that one is a card with 11px sans column heads and
 * 12px rows, and these tables are set open on the surface in mono, with
 * uppercase tracked heads and 38px rows. Same job, different register, and the
 * register is the point.
 * -----------------------------------------------------------------------------------------------*/

/**
 * Head + body. Scrolls sideways once the fixed-width columns outgrow the panel,
 * instead of squishing them: `min-w-fit` measures the fixed lanes, and the one
 * `w-0 flex-1` name lane contributes nothing to that measure, so the table is
 * exactly as wide as its numbers need and the name takes whatever is left.
 */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("overflow-x-auto", className)}>
			<div className="min-w-fit">{children}</div>
		</div>
	)
}

/** A column head row: 30px, hairline above and below. The body scrolls under it. */
export function TableHead({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"flex h-[30px] shrink-0 items-center gap-3 border-y border-border px-2.5",
				className,
			)}
		>
			{children}
		</div>
	)
}

/**
 * One column head. `width` is the lane every cell in the column shares — fixed
 * widths with `shrink-0`, so the columns stay aligned across rows however long
 * a name is, and one `w-0 flex-1` lane for the name.
 */
export function Th<K extends string>({
	label,
	width,
	align = "left",
	sortKey,
	currentKey,
	dir,
	onSort,
	hidden,
}: {
	label: string
	width: string
	align?: "left" | "right"
	sortKey?: K
	currentKey?: K | null
	dir?: SortDir
	onSort?: (k: K) => void
	hidden?: string
}) {
	const active = sortKey !== undefined && currentKey === sortKey
	const text = "font-mono text-[10.5px] uppercase leading-3.5 tracking-[0.07em] transition-colors"
	return (
		<div className={cn("flex items-center", align === "right" && "justify-end", width, hidden)}>
			{sortKey !== undefined ? (
				<button
					type="button"
					onClick={() => onSort?.(sortKey)}
					className={cn(
						"inline-flex items-center gap-1",
						text,
						active ? "text-foreground" : "text-muted-foreground/80 hover:text-foreground",
					)}
				>
					{label}
					<ArrowUpDownIcon
						size={9}
						className={cn(
							"transition-opacity",
							active ? "text-primary opacity-100" : "opacity-0",
							active && dir === "asc" && "rotate-180",
						)}
					/>
				</button>
			) : (
				<span className={cn(text, "text-muted-foreground/80")}>{label}</span>
			)}
		</div>
	)
}

/** Rows scroll inside this once a list outgrows it, so one long table never
 *  pushes the sections under it off the page. */
export function TableBody({
	maxHeight = 460,
	waiting,
	children,
}: {
	maxHeight?: number
	waiting?: boolean
	children: ReactNode
}) {
	return (
		<div
			className={cn("overflow-y-auto overscroll-contain transition-opacity", waiting && "opacity-60")}
			style={{ maxHeight }}
		>
			{children}
		</div>
	)
}

/**
 * The row: 38px, a hairline under it, and a 2px lane reserved on the left that
 * only a selected row paints — so rows never shift sideways as a selection
 * moves. The same mark the metric strip uses.
 */
export const ROW =
	"relative flex h-[38px] w-full shrink-0 items-center gap-3 border-b border-border/50 px-2.5 text-left transition-colors last:border-0 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors focus-visible:outline-none"
export const ROW_SELECTED = "bg-muted/50 before:bg-primary"
export const ROW_IDLE = "before:bg-transparent hover:bg-muted/30 focus-visible:bg-muted/30"

export function TableEmpty({ children }: { children: ReactNode }) {
	return <div className="px-2.5 py-12 text-center font-mono text-xs text-muted-foreground">{children}</div>
}

/** The table's closing line: what is on screen, then the totals behind it. */
export function TableFooter({ subject, detail }: { subject: string; detail: string }) {
	return (
		<div className="flex h-9 items-center gap-[9px] px-2.5 font-mono text-xs">
			<span className="text-muted-foreground">{subject}</span>
			<span className="text-muted-foreground/60">{detail}</span>
		</div>
	)
}

/**
 * Error rate → severity tone. Thresholds rather than a gradient because the
 * question is triage-shaped: under 1% is background noise for a tool that runs
 * thousands of times, over 10% is something a person should look at today.
 */
export function errorTone(rate: number): { bar: string; text: string } {
	if (rate >= 0.1) return { bar: "bg-[var(--severity-error)]", text: "text-[var(--severity-error)]" }
	if (rate >= 0.01) return { bar: "bg-[var(--severity-warn)]", text: "text-[var(--severity-warn)]" }
	return { bar: "bg-[var(--severity-info)]", text: "text-muted-foreground" }
}

export function formatRate(rate: number): string {
	return rate === 0 ? "—" : `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`
}

/**
 * A share column: a bar scaled against the worst row in the table, and the
 * number itself.
 *
 * Against the worst row rather than against 100%, because a table where every
 * tool fails under 2% would otherwise be a column of invisible slivers — and
 * ranking these rows against each other is the entire job of the column. The
 * value beside it is what keeps the bar from being read as an absolute.
 */
export function ShareCell({
	ratio,
	max,
	label,
	tone,
}: {
	ratio: number
	max: number
	label: string
	tone: { bar: string; text: string }
}) {
	const width = relativeRatio(ratio, max)
	return (
		<span className="flex w-[150px] shrink-0 items-center justify-end gap-2.5">
			<span className="hidden h-1 w-[60px] shrink-0 overflow-hidden rounded-[2px] bg-muted @min-[560px]/panel:block">
				<span
					className={cn("block h-full", tone.bar)}
					style={{ width: `${Math.max(width * 100, ratio > 0 ? 3 : 0)}%` }}
				/>
			</span>
			<span className={cn("w-[46px] text-right font-mono text-xs tabular-nums", tone.text)}>
				{label}
			</span>
		</span>
	)
}

/** A 110×22 line: the row's call volume over the window, in the primary. */
export function LineSpark({ values, className }: { values: ReadonlyArray<number>; className?: string }) {
	if (values.length < 2) return <span className="h-[22px] w-[110px] shrink-0" />
	const max = Math.max(...values, 0.0001)
	const step = 110 / (values.length - 1)
	const points = values
		.map((value, index) => {
			const safe = Number.isFinite(value) && value >= 0 ? value : 0
			return `${(index * step).toFixed(1)},${(20 - (safe / max) * 18).toFixed(1)}`
		})
		.join(" ")
	return (
		<svg viewBox="0 0 110 22" className={cn("h-[22px] w-[110px] shrink-0", className)} aria-hidden>
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth={1.5}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	)
}

/** `slowest` / `new` — one word, in the tone of what it is saying. */
export function Badge({ badge }: { badge: ToolBadge }) {
	return (
		<span
			className={cn(
				"flex h-[17px] shrink-0 items-center rounded-[3px] px-1.5 font-mono text-2xs leading-3",
				badge === "slowest"
					? "bg-[var(--severity-error)]/20 text-[var(--severity-error)]"
					: "bg-muted text-muted-foreground",
			)}
		>
			{badge}
		</span>
	)
}

type ToolSortKey = "key" | "calls" | "p50" | "p90" | "p95" | "errorRate" | "errors" | "sessions" | "lastSeen"

interface ToolsTableProps {
	rows: ReadonlyArray<ToolBreakdownRow>
	/** Which percentile the page is keyed on — that column is the lit one. */
	percentile: ToolPercentile
	/** The window, for the `new` badge and nothing else. */
	window: { startMs: number; endMs: number }
	/**
	 * Carried into every row's link. The AMBIENT scope only — the toolbar's
	 * filters and the window — never `q` or `tool`: `q` ILIKE-filters tool names,
	 * and on a page that is one tool it would filter that tool's own name out.
	 */
	detailSearch: ToolDetailLinkSearch
	/** The tool a `?tool=` link arrived with, drawn as the selected row. */
	selected: string | undefined
	/** That tool's call volume over the window, for the row's spark. */
	sparkFor: (tool: string) => ReadonlyArray<number>
	/** The colour the chart draws this tool in, or none when it is not a line there. */
	colorFor: (tool: string) => string | undefined
	/** The read has not answered yet — distinct from a window with no tool calls. */
	loading?: boolean
	/** The read failed — the same distinction, from the other side. */
	failure?: unknown
	waiting?: boolean
}

/**
 * Every tool in the window, ranked, each row a click away from its own page.
 *
 * All three percentiles at once, not the one the strip is keyed on: "is the
 * tail getting worse while the median holds?" is the question this table is
 * scanned for, and it cannot be asked one column at a time. The percentile the
 * page IS keyed on is the bright one, so the table still says which number the
 * chart above it is drawing.
 */
export function ToolsTable({
	rows,
	percentile,
	window,
	detailSearch,
	selected,
	sparkFor,
	colorFor,
	loading,
	failure,
	waiting,
}: ToolsTableProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const prepared = useMemo(
		() => rows.map((row) => ({ ...row, errorRate: errorRate(row) })),
		[rows],
	)
	const maxErrorRate = useMemo(
		() => prepared.reduce((max, row) => Math.max(max, row.errorRate), 0),
		[prepared],
	)
	const badges = useMemo(() => toolBadges(rows, window), [rows, window])
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(prepared, {
		initialKey: "calls" as ToolSortKey,
		stringKeys: ["key"],
	})
	const footer = toolsTableFooter(rows)

	const duration = (value: number, driving: boolean, hidden?: string) => (
		<span
			className={cn(
				"w-[76px] shrink-0 text-right font-mono text-xs tabular-nums",
				driving ? "text-foreground/85" : "text-muted-foreground",
				hidden,
			)}
		>
			{formatDurationNs(value)}
		</span>
	)

	return (
		<section className="@container/panel min-w-0 px-6 pt-5 pb-6" aria-label="Tools">
			<div className="flex items-baseline gap-2.5 pb-3 font-mono">
				<span className="text-[12.5px] font-medium text-foreground">Tools</span>
				<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
					{formatToolCount(rows.length)}
				</span>
			</div>

			<Table>
				<TableHead>
					<Th<ToolSortKey>
						label="Tool"
						width="w-0 flex-1 min-w-0"
						sortKey="key"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th label="Volume" width="w-[110px] shrink-0" hidden="hidden @min-[720px]/panel:flex" />
					<Th<ToolSortKey>
						label="Calls"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ToolSortKey>
						label="P50"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="p50"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[900px]/panel:flex"
					/>
					<Th<ToolSortKey>
						label="P90"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="p90"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ToolSortKey>
						label="P95"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="p95"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[900px]/panel:flex"
					/>
					<Th<ToolSortKey>
						label="Error rate"
						width="w-[150px] shrink-0 pl-6"
						sortKey="errorRate"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ToolSortKey>
						label="Errors"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[640px]/panel:flex"
					/>
					<Th<ToolSortKey>
						label="Sessions"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="sessions"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[640px]/panel:flex"
					/>
					<Th<ToolSortKey>
						label="Last call"
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

				<TableBody waiting={waiting}>
					{failure !== undefined ? (
						<QueryErrorState error={failure} titleOverride="Failed to load tools" />
					) : loading ? (
						<div className="flex flex-col gap-1.5 px-2.5 py-3">
							<Skeleton className="h-[38px]" />
							<Skeleton className="h-[38px]" />
							<Skeleton className="h-[38px]" />
						</div>
					) : sorted.length === 0 ? (
						<TableEmpty>No tool calls in the selected window.</TableEmpty>
					) : (
						sorted.map((row) => {
							const color = colorFor(row.key)
							const badge = badges.get(row.key)
							const cells = (
								<>
									<span className="flex w-0 min-w-0 flex-1 items-center gap-[9px]">
										<span
											aria-hidden
											className={cn(
												"size-2 shrink-0 rounded-[2px]",
												color === undefined && "bg-muted-foreground/50",
											)}
											style={color === undefined ? undefined : { backgroundColor: color }}
										/>
										<span
											className={cn(
												"truncate font-mono text-[12.5px] text-foreground",
												row.key === selected && "font-medium",
											)}
											title={breakdownKeyLabel(row.key)}
										>
											{breakdownKeyLabel(row.key)}
										</span>
										{badge === undefined ? null : <Badge badge={badge} />}
									</span>
									<LineSpark
										values={sparkFor(row.key).slice(-24)}
										className="hidden text-primary/70 @min-[720px]/panel:block"
									/>
									<span className="w-[76px] shrink-0 text-right font-mono text-[12.5px] tabular-nums text-foreground">
										{formatToolCount(row.calls)}
									</span>
									{duration(row.p50, percentile === "p50", "hidden @min-[900px]/panel:block")}
									{duration(row.p90, percentile === "p90")}
									{duration(row.p95, percentile === "p95", "hidden @min-[900px]/panel:block")}
									<ShareCell
										ratio={row.errorRate}
										max={maxErrorRate}
										label={formatRate(row.errorRate)}
										tone={errorTone(row.errorRate)}
									/>
									<span
										className={cn(
											"hidden w-[76px] shrink-0 text-right font-mono text-xs tabular-nums @min-[640px]/panel:block",
											row.errors > 0
												? "text-[var(--severity-error)]"
												: "text-muted-foreground/60",
										)}
									>
										{formatToolCount(row.errors)}
									</span>
									<span className="hidden w-[76px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @min-[640px]/panel:block">
										{formatToolCount(row.sessions)}
									</span>
									<span className="hidden w-[96px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70 @min-[800px]/panel:block">
										{formatRelativeTimeOrDate(row.lastSeen, undefined, effectiveTimezone)}
									</span>
									<span className="flex w-3.5 shrink-0 items-center justify-end text-muted-foreground/60">
										{row.key === "" ? null : <ChevronRightIcon size={14} aria-hidden />}
									</span>
								</>
							)

							// The unattributed row has no name to route on: a tool call the
							// index could not name has no page of its own.
							return row.key === "" ? (
								<div key={row.key} className={cn(ROW, "before:bg-transparent")}>
									{cells}
								</div>
							) : (
								<Link
									key={row.key}
									to="/agent-sessions/tools/$toolName"
									params={{ toolName: row.key }}
									search={detailSearch}
									className={cn(ROW, row.key === selected ? ROW_SELECTED : ROW_IDLE)}
								>
									{cells}
								</Link>
							)
						})
					)}
				</TableBody>
			</Table>

			<TableFooter subject={footer.subject} detail={footer.detail} />
		</section>
	)
}

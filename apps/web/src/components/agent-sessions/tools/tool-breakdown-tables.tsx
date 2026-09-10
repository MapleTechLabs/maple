import { useMemo, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { useTableSort, type SortDir } from "@/components/infra/primitives/data-table"
import { relativeRatio } from "@/components/infra/primitives/share-bar"
import { ArrowUpDownIcon, ChevronRightIcon } from "@/components/icons"
import { ModelLabel } from "@/components/agent-sessions/model-label"
import type { DetectedModel } from "@/hooks/use-detected-models"
import {
	breakdownKeyLabel,
	errorRate,
	formatDurationNs,
	type ToolBreakdownRow,
	type ToolPercentile,
} from "@/lib/agent-sessions/tool-analytics"

/* -------------------------------------------------------------------------------------------------
 * Table chrome shared by the three tables on this page
 *
 * Not the infra `DataTable`: that one is a card with 11px sans column heads and
 * 12px rows, and this page's tables are set open on the surface in mono, with
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

/** Rows scroll inside this once a list outgrows it, so the page never grows past the sessions below. */
export function TableBody({
	maxHeight = 420,
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
 * The selected-row marker: a 2px lane reserved on every row and painted only
 * on the picked one, so the rows never shift sideways as the selection moves.
 * The same mark as the metric strip's — "this is what the chart is now about".
 */
export const ROW =
	"relative flex h-[38px] w-full shrink-0 items-center gap-3 border-b border-border/50 px-2.5 text-left transition-colors last:border-0 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors focus-visible:outline-none"
export const ROW_SELECTED = "bg-muted/50 before:bg-primary"
export const ROW_IDLE = "before:bg-transparent hover:bg-muted/30 focus-visible:bg-muted/30"

export function TableEmpty({ children }: { children: ReactNode }) {
	return <div className="px-2.5 py-12 text-center font-mono text-xs text-muted-foreground">{children}</div>
}

/**
 * Error rate → severity tone. Thresholds rather than a gradient because the
 * question is triage-shaped: under 1% is background noise for a tool that runs
 * thousands of times, over 10% is something a person should look at today.
 */
function errorTone(rate: number): { bar: string; text: string } {
	if (rate >= 0.1)
		return {
			bar: "bg-[var(--severity-error)]",
			text: "text-[var(--severity-error)]",
		}
	if (rate >= 0.01)
		return {
			bar: "bg-[var(--severity-warn)]",
			text: "text-[var(--severity-warn)]",
		}
	return { bar: "bg-[var(--severity-info)]", text: "text-muted-foreground" }
}

function formatRate(rate: number): string {
	return rate === 0 ? "—" : `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`
}

/**
 * The error column: a bar scaled against the worst row in the table, and the
 * rate itself.
 *
 * Against the worst row rather than against 100%, because a table where every
 * tool fails under 2% would otherwise be a column of invisible slivers — and
 * ranking these rows against each other is the entire job of the column. The
 * percentage beside it is what keeps the bar from being read as an absolute.
 */
function ErrorCell({ rate, max, emphasis }: { rate: number; max: number; emphasis?: boolean }) {
	const tone = errorTone(rate)
	const ratio = relativeRatio(rate, max)
	return (
		<span className="flex w-[116px] shrink-0 items-center justify-end gap-2.5">
			<span className="hidden h-1 w-[60px] shrink-0 overflow-hidden rounded-[2px] bg-muted @min-[520px]/panel:block">
				<span
					className={cn("block h-full", tone.bar)}
					style={{ width: `${Math.max(ratio * 100, rate > 0 ? 3 : 0)}%` }}
				/>
			</span>
			<span
				className={cn(
					"w-[46px] text-right font-mono text-xs tabular-nums",
					tone.text,
					emphasis && "font-medium",
				)}
			>
				{formatRate(rate)}
			</span>
		</span>
	)
}

/** A 64×22 line: the row's metric over the window, in the tool's series colour when selected. */
function LineSpark({ values, className }: { values: ReadonlyArray<number>; className?: string }) {
	if (values.length < 2) return <span className="h-[22px] w-16 shrink-0" />
	const max = Math.max(...values, 0.0001)
	const step = 110 / (values.length - 1)
	const points = values
		.map((v, i) => {
			const safe = Number.isFinite(v) && v >= 0 ? v : 0
			return `${(i * step).toFixed(1)},${(20 - (safe / max) * 18).toFixed(1)}`
		})
		.join(" ")
	return (
		<svg viewBox="0 0 110 22" className={cn("h-[22px] w-16 shrink-0", className)} aria-hidden>
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

type ToolSortKey = "key" | "calls" | "duration" | "errors" | "sessions"

interface ToolsTableProps {
	rows: ReadonlyArray<ToolBreakdownRow>
	percentile: ToolPercentile
	/** The picked tool (`?tool=`), rendered as the selected row. */
	selected: string | undefined
	/** Clicking the picked row clears it — selection is a toggle, like the analytics breakdowns. */
	onSelect: (tool: string | undefined) => void
	/** That tool's metric over the window, for the row's spark. Empty where the series does not cover it. */
	sparkFor: (tool: string) => ReadonlyArray<number>
	/** The colour the chart draws this tool in, or none when it is not a line there. */
	colorFor: (tool: string) => string | undefined
	waiting?: boolean
}

/**
 * The page's primary breakdown: every tool in the window, ranked, each row a
 * click away from becoming the page's scope.
 *
 * One duration column, not three. The percentile is already chosen in the
 * metric strip and shown in the column head, so three latency columns here
 * would restate a decision the reader has made and leave the name column
 * nothing to live in.
 */
export function ToolsTable({
	rows,
	percentile,
	selected,
	onSelect,
	sparkFor,
	colorFor,
	waiting,
}: ToolsTableProps) {
	const prepared = useMemo(
		() =>
			rows.map((row) => ({
				...row,
				duration: row[percentile],
				errorRate: errorRate(row),
			})),
		[rows, percentile],
	)
	const maxErrorRate = useMemo(
		() => prepared.reduce((max, row) => Math.max(max, row.errorRate), 0),
		[prepared],
	)
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(prepared, {
		initialKey: "calls" as ToolSortKey,
		stringKeys: ["key"],
	})

	return (
		<section className="@container/panel min-w-0 px-6 py-5" aria-label="Tools breakdown">
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pb-3 font-mono">
				<span className="text-[12.5px] font-medium text-foreground">Tools</span>
				<span className="text-[11.5px] leading-3.5 text-muted-foreground/70">
					{formatNumber(rows.length)} · click a row to scope the chart, KPIs and sessions
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
					<Th label="Volume" width="w-16 shrink-0" hidden="hidden @min-[520px]/panel:flex" />
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
						label={percentile.toUpperCase()}
						width="w-[62px] shrink-0"
						align="right"
						sortKey="duration"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ToolSortKey>
						label="Error rate"
						width="w-[116px] shrink-0 pl-6"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ToolSortKey>
						label="Sessions"
						width="w-[62px] shrink-0"
						align="right"
						sortKey="sessions"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[600px]/panel:flex"
					/>
					<span className="w-3.5 shrink-0" aria-hidden />
				</TableHead>

				<TableBody waiting={waiting}>
					{sorted.length === 0 ? (
						<TableEmpty>No tool calls in the selected window.</TableEmpty>
					) : (
						sorted.map((row) => {
							const isSelected = row.key === selected
							const color = colorFor(row.key)
							return (
								<button
									key={row.key}
									type="button"
									aria-pressed={isSelected}
									disabled={row.key === ""}
									onClick={() => onSelect(isSelected ? undefined : row.key)}
									className={cn(
										ROW,
										isSelected ? ROW_SELECTED : ROW_IDLE,
										row.key === "" && "cursor-default",
									)}
								>
									<span className="flex w-0 min-w-0 flex-1 items-center gap-[9px]">
										<span
											aria-hidden
											className={cn(
												"size-2 shrink-0 rounded-[2px]",
												color === undefined && "bg-muted-foreground/30",
											)}
											style={
												color === undefined ? undefined : { backgroundColor: color }
											}
										/>
										<span
											className={cn(
												"truncate font-mono text-[12.5px] text-foreground",
												isSelected && "font-medium",
											)}
											title={breakdownKeyLabel(row.key)}
										>
											{breakdownKeyLabel(row.key)}
										</span>
									</span>
									<LineSpark
										values={sparkFor(row.key).slice(-16)}
										className={cn(
											"hidden @min-[520px]/panel:block",
											isSelected ? "text-primary" : "text-primary/60",
										)}
									/>
									<span
										className={cn(
											"w-[76px] shrink-0 text-right font-mono text-[12.5px] tabular-nums text-foreground",
											isSelected && "font-medium",
										)}
									>
										{formatNumber(row.calls)}
									</span>
									<span className="w-[62px] shrink-0 text-right font-mono text-xs tabular-nums text-foreground/80">
										{formatDurationNs(row.duration)}
									</span>
									<ErrorCell
										rate={row.errorRate}
										max={maxErrorRate}
										emphasis={isSelected}
									/>
									<span className="hidden w-[62px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @min-[600px]/panel:block">
										{formatNumber(row.sessions)}
									</span>
									<span className="flex w-3.5 shrink-0 items-center justify-end text-primary">
										{isSelected ? <ChevronRightIcon size={14} aria-hidden /> : null}
									</span>
								</button>
							)
						})
					)}
				</TableBody>
			</Table>
		</section>
	)
}

type ModelSortKey = "key" | "calls" | "duration" | "errors"

interface ModelsPanelProps {
	rows: ReadonlyArray<ToolBreakdownRow>
	percentile: ToolPercentile
	selected: string | undefined
	onSelect: (model: string | undefined) => void
	/** Resolves a model id to its vendor and display name — see `useDetectedModels`. */
	detect: (model: string) => DetectedModel
	waiting?: boolean
	/** Named in the panel's subtitle when a tool narrows it. */
	tool?: string
}

/**
 * The models running the current scope, beside the tools rather than under
 * them: "which tool is slow" and "which model is slow at it" are the same
 * question asked one level apart, and reading them side by side is what makes
 * the second one cheap to ask.
 *
 * Narrower than the Tools table on purpose — no sparkline, no sessions column.
 * A model list is short (single digits, usually), and the comparison it exists
 * for is between four numbers in one glance, not a ranked scan.
 */
export function ModelsPanel({
	rows,
	percentile,
	selected,
	onSelect,
	detect,
	waiting,
	tool,
}: ModelsPanelProps) {
	const prepared = useMemo(
		() =>
			rows.map((row) => ({
				...row,
				duration: row[percentile],
				errorRate: errorRate(row),
			})),
		[rows, percentile],
	)
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(prepared, {
		initialKey: "calls" as ModelSortKey,
		stringKeys: ["key"],
	})

	return (
		<section
			className="@container/panel min-w-0 border-t border-border px-6 py-5 @min-[1000px]/page:border-t-0 @min-[1000px]/page:border-l"
			aria-label="Models breakdown"
		>
			<div className="flex h-7 items-center gap-2 font-mono">
				<span className="text-[12.5px] font-medium text-foreground">Models</span>
				<span className="text-[11px] tabular-nums text-muted-foreground">
					{formatNumber(rows.length)}
				</span>
				{tool === undefined ? null : (
					<span className="truncate text-[11px] text-muted-foreground/60">within {tool}</span>
				)}
			</div>

			<Table>
				<TableHead className="border-t-0">
					<Th<ModelSortKey>
						label="Model"
						width="w-0 flex-1 min-w-0"
						sortKey="key"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ModelSortKey>
						label="Calls"
						width="w-[62px] shrink-0"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ModelSortKey>
						label={percentile.toUpperCase()}
						width="w-[66px] shrink-0"
						align="right"
						sortKey="duration"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ModelSortKey>
						label="Err"
						width="w-[58px] shrink-0"
						align="right"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
				</TableHead>

				<TableBody waiting={waiting}>
					{sorted.length === 0 ? (
						<TableEmpty>No models reported for this scope.</TableEmpty>
					) : (
						sorted.map((row) => {
							const isSelected = row.key === selected
							return (
								<button
									key={row.key}
									type="button"
									aria-pressed={isSelected}
									disabled={row.key === ""}
									onClick={() => onSelect(isSelected ? undefined : row.key)}
									className={cn(
										ROW,
										isSelected ? ROW_SELECTED : ROW_IDLE,
										row.key === "" && "cursor-default",
									)}
								>
									<span className="w-0 min-w-0 flex-1 font-mono text-xs text-foreground">
										{row.key === "" ? (
											<span className="text-muted-foreground">
												{breakdownKeyLabel(row.key)}
											</span>
										) : (
											<ModelLabel
												detected={detect(row.key)}
												size={12}
												className={cn(
													"gap-[7px]",
													isSelected
														? "[&_svg]:text-primary"
														: "[&_svg]:text-muted-foreground",
												)}
											/>
										)}
									</span>
									<span className="w-[62px] shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
										{formatNumber(row.calls)}
									</span>
									<span
										className={cn(
											"w-[66px] shrink-0 text-right font-mono text-xs tabular-nums",
											isSelected ? "text-foreground" : "text-muted-foreground",
										)}
									>
										{formatDurationNs(row.duration)}
									</span>
									<span
										className={cn(
											"w-[58px] shrink-0 text-right font-mono text-xs tabular-nums",
											errorTone(row.errorRate).text,
										)}
									>
										{formatRate(row.errorRate)}
									</span>
								</button>
							)
						})
					)}
				</TableBody>
			</Table>

			<div className="flex h-9 items-center px-2.5 font-mono text-[11px] text-muted-foreground">
				Click a model to narrow the chart to one line.
			</div>
		</section>
	)
}

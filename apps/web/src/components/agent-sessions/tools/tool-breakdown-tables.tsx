import { useMemo, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { ColumnHead, DataTable, useTableSort } from "@/components/infra/primitives/data-table"
import { BarSpark } from "@/components/infra/primitives/stat-rail"
import { relativeRatio } from "@/components/infra/primitives/share-bar"
import { ModelLabel } from "@/components/agent-sessions/model-label"
import type { DetectedModel } from "@/hooks/use-detected-models"
import {
	breakdownKeyLabel,
	errorRate,
	formatDurationNs,
	type ToolBreakdownRow,
	type ToolPercentile,
} from "@/lib/agent-sessions/tool-analytics"

/**
 * The selected-row marker, and the one place it is defined for this page.
 *
 * Identical in shape to the metric strip's: a 2px lane reserved on every row and
 * painted only on the picked one, so the rows never shift sideways as the
 * selection moves. It is the same gesture in both places — "this is what the
 * chart is now about" — and so it is the same mark, in the same colour.
 */
const ROW = "relative flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left transition-colors last:border-0 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors focus-visible:outline-none"
const ROW_SELECTED = "bg-primary/5 before:bg-primary"
const ROW_IDLE = "before:bg-transparent hover:bg-muted/40 focus-visible:bg-muted/40"

/**
 * Error rate → severity tone. Thresholds rather than a gradient because the
 * question is triage-shaped: under 1% is background noise for a tool that runs
 * thousands of times, over 10% is something a person should look at today.
 */
function errorTone(rate: number): { bar: string; text: string } {
	if (rate >= 0.1) return { bar: "bg-[var(--severity-error)]", text: "text-[var(--severity-error)]" }
	if (rate >= 0.01) return { bar: "bg-[var(--severity-warn)]", text: "text-[var(--severity-warn)]" }
	return { bar: "bg-muted-foreground/40", text: "text-muted-foreground" }
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
function ErrorCell({ rate, max }: { rate: number; max: number }) {
	const tone = errorTone(rate)
	const ratio = relativeRatio(rate, max)
	return (
		<span className="flex items-center justify-end gap-2">
			<span className="hidden h-1 w-10 overflow-hidden rounded-full bg-muted @min-[420px]/panel:block">
				<span
					className={cn("block h-full rounded-full", tone.bar)}
					style={{ width: `${Math.max(ratio * 100, rate > 0 ? 6 : 0)}%` }}
				/>
			</span>
			<span className={cn("font-mono text-[11px] tabular-nums", tone.text)}>
				{rate === 0 ? "—" : `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`}
			</span>
		</span>
	)
}

/** Card frame both breakdown panels sit in. */
function Panel({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
	return (
		// Its own container query: these two sit side by side at wide widths and
		// stack at narrow ones, so neither the page column nor the viewport is an
		// honest measure of how much room a row actually has.
		<div className="@container/panel rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5 pb-2">
				<span className="text-[11px] font-medium text-muted-foreground">{title}</span>
				{meta}
			</div>
			{children}
		</div>
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
	waiting,
}: ToolsTableProps) {
	const prepared = useMemo(
		() => rows.map((row) => ({ ...row, duration: row[percentile], errorRate: errorRate(row) })),
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
		<Panel
			title="Tools"
			meta={
				<span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
					{formatNumber(rows.length)} tools
				</span>
			}
		>
			<DataTable.Root ariaLabel="Tools breakdown" waiting={waiting} maxHeight={420} stickySurfaceClass="bg-card">
				<DataTable.Head>
					<ColumnHead<ToolSortKey>
						label="Tool"
						width="w-0 flex-1 min-w-0"
						sortKey="key"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<span className="hidden w-16 @min-[520px]/panel:block" aria-hidden />
					<ColumnHead<ToolSortKey>
						label="Calls"
						width="w-16"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<ToolSortKey>
						label={percentile.toUpperCase()}
						width="w-16"
						align="right"
						sortKey="duration"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<ToolSortKey>
						label="Errors"
						width="w-20"
						align="right"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<ToolSortKey>
						label="Sessions"
						width="w-16"
						align="right"
						sortKey="sessions"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[600px]/panel:flex"
					/>
				</DataTable.Head>

				{sorted.length === 0 ? (
					<DataTable.Empty>No tool calls in the selected window.</DataTable.Empty>
				) : (
					sorted.map((row) => {
						const isSelected = row.key === selected
						const spark = sparkFor(row.key)
						return (
							<button
								key={row.key}
								type="button"
								aria-pressed={isSelected}
								disabled={row.key === ""}
								onClick={() => onSelect(isSelected ? undefined : row.key)}
								className={cn(ROW, isSelected ? ROW_SELECTED : ROW_IDLE, row.key === "" && "cursor-default")}
							>
								<span
									className={cn(
										"w-0 min-w-0 flex-1 truncate font-mono text-[12px]",
										isSelected ? "text-foreground" : "text-foreground/90",
									)}
									title={breakdownKeyLabel(row.key)}
								>
									{breakdownKeyLabel(row.key)}
								</span>
								<span className="hidden w-16 @min-[520px]/panel:block">
									{spark.length > 1 ? (
										<BarSpark
											values={spark.slice(-28)}
											color="var(--muted-foreground)"
											className="h-4 w-16"
										/>
									) : null}
								</span>
								<span className="w-16 text-right font-mono text-[11px] tabular-nums">
									{formatNumber(row.calls)}
								</span>
								<span className="w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
									{formatDurationNs(row.duration)}
								</span>
								<span className="w-20">
									<ErrorCell rate={row.errorRate} max={maxErrorRate} />
								</span>
								<span className="hidden w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground @min-[600px]/panel:block">
									{formatNumber(row.sessions)}
								</span>
							</button>
						)
					})
				)}
			</DataTable.Root>
		</Panel>
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
		() => rows.map((row) => ({ ...row, duration: row[percentile], errorRate: errorRate(row) })),
		[rows, percentile],
	)
	const maxErrorRate = useMemo(
		() => prepared.reduce((max, row) => Math.max(max, row.errorRate), 0),
		[prepared],
	)
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(prepared, {
		initialKey: "calls" as ModelSortKey,
		stringKeys: ["key"],
	})

	return (
		<Panel
			title="Models"
			meta={
				tool === undefined ? undefined : (
					<span className="truncate font-mono text-[10px] text-muted-foreground/80">
						running {tool}
					</span>
				)
			}
		>
			<DataTable.Root ariaLabel="Models breakdown" waiting={waiting} maxHeight={420} stickySurfaceClass="bg-card">
				<DataTable.Head>
					<ColumnHead<ModelSortKey>
						label="Model"
						width="w-0 flex-1 min-w-0"
						sortKey="key"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<ModelSortKey>
						label="Calls"
						width="w-16"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<ModelSortKey>
						label={percentile.toUpperCase()}
						width="w-16"
						align="right"
						sortKey="duration"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<ModelSortKey>
						label="Errors"
						width="w-20"
						align="right"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
				</DataTable.Head>

				{sorted.length === 0 ? (
					<DataTable.Empty>No models reported for this scope.</DataTable.Empty>
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
								className={cn(ROW, isSelected ? ROW_SELECTED : ROW_IDLE, row.key === "" && "cursor-default")}
							>
								<span className="w-0 min-w-0 flex-1 text-[12px]">
									{row.key === "" ? (
										<span className="font-mono text-[12px] text-muted-foreground">{breakdownKeyLabel(row.key)}</span>
									) : (
										<ModelLabel detected={detect(row.key)} size={14} />
									)}
								</span>
								<span className="w-16 text-right font-mono text-[11px] tabular-nums">
									{formatNumber(row.calls)}
								</span>
								<span className="w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
									{formatDurationNs(row.duration)}
								</span>
								<span className="w-20">
									<ErrorCell rate={row.errorRate} max={maxErrorRate} />
								</span>
							</button>
						)
					})
				)}
			</DataTable.Root>
		</Panel>
	)
}

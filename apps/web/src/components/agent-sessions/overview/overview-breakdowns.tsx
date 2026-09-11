import { useState } from "react"

import { formatErrorRate, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	formatOverviewCount,
	type OverviewBreakdown,
	type OverviewBreakdownRow,
} from "@/lib/agent-sessions/overview-analytics"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import {
	selectedDimensionValue,
	type AgentOverviewSearch,
	type OverviewDimension,
} from "@/lib/agent-sessions/overview-search"

export interface OverviewBreakdownsProps {
	/** All six, in the dimensions' own order. */
	breakdowns: ReadonlyArray<OverviewBreakdown>
	search: AgentOverviewSearch
	/** Toggles that dimension's filter for the whole page. */
	onSelectRow: (dimension: OverviewDimension, key: string) => void
	waiting?: boolean
}

/** The columns a dimension can actually attribute — see `AiOverviewBreakdownRow`. */
const USAGE_COLUMNS = [
	"Share of cost",
	"Sessions",
	"LLM calls",
	"Tok / sess",
	"Cost",
	"$ / sess",
	"Error rate",
	"Δ prev",
] as const

const TOOL_COLUMNS = [
	"Share of calls",
	"Sessions",
	"Calls",
	"Errors",
	"Error rate",
	"Δ prev",
] as const

/**
 * The same window, grouped six ways.
 *
 * A row is not a link but a filter: clicking one narrows every reading on the
 * page to that key, and clicking it again gives the page back. Rows OVERLAP —
 * a session that used two models is a session under each — which the footer
 * says out loud rather than leaving a reader to reconcile the columns.
 */
export function OverviewBreakdowns({
	breakdowns,
	search,
	onSelectRow,
	waiting = false,
}: OverviewBreakdownsProps) {
	const [active, setActive] = useState<OverviewDimension>("model")
	const breakdown = breakdowns.find((item) => item.dimension === active)
	const isTool = active === "tool"
	const columns = isTool ? TOOL_COLUMNS : USAGE_COLUMNS
	const selected = selectedDimensionValue(search, active)

	return (
		<section className={cn("border-b border-border px-6 py-4", waiting && "opacity-60")}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-2">
				<h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
					Breakdowns
				</h2>
				<span className="font-mono text-[11.5px] text-muted-foreground">
					click a row to filter the whole page
				</span>
			</div>

			<div className="flex flex-wrap items-center gap-1 pb-2">
				{breakdowns.map((item) => (
					<button
						key={item.dimension}
						type="button"
						aria-pressed={item.dimension === active}
						onClick={() => setActive(item.dimension)}
						className={cn(
							"inline-flex h-[26px] items-center gap-1.5 rounded border px-2 font-mono text-[11.5px] transition-colors",
							item.dimension === active
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{item.dimension}
						<span className="text-[10.5px] tabular-nums opacity-70">{item.totalKeys}</span>
					</button>
				))}
			</div>

			{breakdown === undefined || breakdown.rows.length === 0 ? (
				<p className="py-6 font-mono text-[11.5px] text-muted-foreground/70">
					No {active} activity in this range.
				</p>
			) : (
				<>
					<table className="w-full table-auto border-collapse font-mono text-[12px]">
						<thead>
							<tr className="border-b border-border text-left">
								<th className="py-1.5 pr-3 font-normal text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80">
									{active}
								</th>
								{columns.map((column) => (
									<th
										key={column}
										className="py-1.5 pl-3 text-right font-normal text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80"
									>
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{breakdown.rows.map((row) => (
								<tr
									key={row.key}
									onClick={() => onSelectRow(active, row.key)}
									data-selected={row.key === selected ? "" : undefined}
									className={cn(
										"cursor-pointer border-b border-border/60 transition-colors hover:bg-accent/40",
										row.key === selected && "bg-primary/10",
									)}
								>
									<td className="max-w-[220px] truncate py-1.5 pr-3 text-foreground">
										{row.label}
									</td>
									{isTool ? <ToolCells row={row} /> : <UsageCells row={row} />}
								</tr>
							))}
						</tbody>
					</table>
					<p className="pt-2 font-mono text-[10.5px] text-muted-foreground/60">
						{breakdown.totalKeys} keys · session counts overlap where a session used more than
						one {active}
						{breakdown.totalKeys > breakdown.rows.length
							? ` · + ${breakdown.totalKeys - breakdown.rows.length} more`
							: ""}
					</p>
				</>
			)}
		</section>
	)
}

const Cell = ({ children }: { children: React.ReactNode }) => (
	<td className="py-1.5 pl-3 text-right tabular-nums text-muted-foreground">{children}</td>
)

function UsageCells({ row }: { row: OverviewBreakdownRow }) {
	return (
		<>
			<Cell>{formatPercent(row.shareOfCost)}</Cell>
			<Cell>{formatOverviewCount(row.sessions)}</Cell>
			<Cell>{formatOverviewCount(row.llmCalls)}</Cell>
			<Cell>{formatNumber(row.tokensPerSession)}</Cell>
			<Cell>{formatCost(row.cost)}</Cell>
			<Cell>{formatCost(row.costPerSession)}</Cell>
			<Cell>{formatErrorRate(row.errorRate)}</Cell>
			<Cell>{formatDeltaPp(row.errorRateDeltaPp)}</Cell>
		</>
	)
}

function ToolCells({ row }: { row: OverviewBreakdownRow }) {
	return (
		<>
			<Cell>{formatPercent(row.shareOfCalls)}</Cell>
			<Cell>{formatOverviewCount(row.sessions)}</Cell>
			<Cell>{formatOverviewCount(row.toolCalls)}</Cell>
			<Cell>{formatOverviewCount(row.toolErrors)}</Cell>
			<Cell>{formatErrorRate(row.errorRate)}</Cell>
			<Cell>{formatDeltaPp(row.errorRateDeltaPp)}</Cell>
		</>
	)
}

/** A key with no previous window has no move to show, which is not a zero. */
const formatDeltaPp = (pp: number | null): string =>
	pp === null ? "—" : `${pp < 0 ? "-" : "+"}${Math.abs(pp).toFixed(1)}pp`

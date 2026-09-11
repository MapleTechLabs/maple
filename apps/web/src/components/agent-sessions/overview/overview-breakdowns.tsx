import { useState } from "react"

import { formatErrorRate, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ChevronRightIcon } from "@/components/icons"
import {
	formatOverviewCount,
	type OverviewBreakdown,
	type OverviewBreakdownRow,
	type OverviewModelMix,
} from "@/lib/agent-sessions/overview-analytics"
import { overviewModelMixColor } from "@/lib/agent-sessions/overview-chart-specs"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import {
	selectedDimensionValue,
	type AgentOverviewSearch,
	type OverviewDimension,
} from "@/lib/agent-sessions/overview-search"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"

export interface OverviewBreakdownsProps {
	/** All six, in the dimensions' own order. */
	breakdowns: ReadonlyArray<OverviewBreakdown>
	/** The plotted bands, so a model's chip here is its band in the mix chart. */
	modelMix: OverviewModelMix
	search: AgentOverviewSearch
	/** Toggles that dimension's filter for the whole page. */
	onSelectRow: (dimension: OverviewDimension, key: string) => void
	waiting?: boolean
}

/** A lane: its header label, its width, and the width it sheds at. */
interface Column {
	readonly label: string
	readonly className: string
}

/** The columns a dimension can actually attribute — see `AiOverviewBreakdownRow`. */
const USAGE_COLUMNS: ReadonlyArray<Column> = [
	{ label: "Share of cost", className: "w-[170px] @max-[900px]/table:hidden" },
	{ label: "Sessions", className: "w-[84px] text-right" },
	{ label: "LLM calls", className: "w-[92px] text-right @max-[700px]/table:hidden" },
	{ label: "Tok / sess", className: "w-[92px] text-right @max-[820px]/table:hidden" },
	{ label: "Cost", className: "w-[92px] text-right" },
	{ label: "$ / sess", className: "w-[88px] text-right @max-[640px]/table:hidden" },
	{ label: "Error rate", className: "w-[116px] text-right" },
	{ label: "Δ prev", className: "w-[86px] text-right @max-[560px]/table:hidden" },
]

const TOOL_COLUMNS: ReadonlyArray<Column> = [
	{ label: "Share of calls", className: "w-[170px] @max-[900px]/table:hidden" },
	{ label: "Sessions", className: "w-[84px] text-right" },
	{ label: "Calls", className: "w-[92px] text-right" },
	{ label: "Errors", className: "w-[92px] text-right @max-[700px]/table:hidden" },
	{ label: "Error rate", className: "w-[116px] text-right" },
	{ label: "Δ prev", className: "w-[86px] text-right @max-[560px]/table:hidden" },
]

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
	modelMix,
	search,
	onSelectRow,
	waiting = false,
}: OverviewBreakdownsProps) {
	const [active, setActive] = useState<OverviewDimension>("model")
	const breakdown = breakdowns.find((item) => item.dimension === active)
	const isTool = active === "tool"
	const columns = isTool ? TOOL_COLUMNS : USAGE_COLUMNS
	const selected = selectedDimensionValue(search, active)
	const rows = breakdown?.rows ?? []
	const worstRate = rows.reduce((max, row) => Math.max(max, row.errorRate), 0)

	return (
		<section className={cn("border-b border-border transition-opacity", waiting && "opacity-60")}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 pt-4 pb-2.5">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
					<h2 className="text-[15px] leading-5 font-semibold tracking-[-0.01em] text-foreground">
						Breakdowns
					</h2>
					<span className="font-mono text-[11.5px] text-muted-foreground">
						click a row to filter the whole page
					</span>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-1 px-6 pb-3">
				{breakdowns.map((item) => (
					<button
						key={item.dimension}
						type="button"
						aria-pressed={item.dimension === active}
						onClick={() => setActive(item.dimension)}
						className={cn(
							"inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11.5px] transition-colors",
							item.dimension === active
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-border text-muted-foreground hover:text-foreground",
						)}
					>
						{item.dimension}
						<span className="tabular-nums opacity-70">{item.totalKeys}</span>
					</button>
				))}
			</div>

			{rows.length === 0 ? (
				<p className="px-6 pb-6 font-mono text-[11.5px] text-muted-foreground/70">
					No {active} activity in this range.
				</p>
			) : (
				<div className="@container/table px-6 pb-4">
					<div className="flex h-[28px] items-center border-b border-border">
						<span className={cn(HEAD, "min-w-0 flex-1")}>{active}</span>
						{columns.map((column) => (
							<span key={column.label} className={cn(HEAD, "shrink-0", column.className)}>
								{column.label}
							</span>
						))}
						<span className="w-[44px] shrink-0" />
					</div>

					{rows.map((row) => (
						<button
							key={row.key}
							type="button"
							aria-pressed={row.key === selected}
							onClick={() => onSelectRow(active, row.key)}
							className={cn(
								"flex h-[38px] w-full items-center border-b border-border/40 text-left transition-colors hover:bg-foreground/[0.06]",
								row.key === selected && "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]",
							)}
						>
							<span className="flex min-w-0 flex-1 items-center gap-2.5 pr-3">
								<Glyph dimension={active} row={row} modelMix={modelMix} />
								<span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
									{row.label}
								</span>
							</span>
							{isTool ? (
								<ToolCells row={row} worstRate={worstRate} />
							) : (
								<UsageCells row={row} worstRate={worstRate} />
							)}
							<span className="flex w-[44px] shrink-0 justify-end">
								<ChevronRightIcon
									size={13}
									className="text-muted-foreground/40"
									aria-hidden
								/>
							</span>
						</button>
					))}

					<p className="flex h-[34px] items-center gap-2 font-mono text-[11px]">
						<span className="text-muted-foreground">{footerTotals(active, rows)}</span>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span className="min-w-0 truncate text-muted-foreground/60">
							session counts overlap where a session used more than one {active}
							{breakdown !== undefined && breakdown.totalKeys > rows.length
								? ` · +${breakdown.totalKeys - rows.length} more`
								: ""}
						</span>
					</p>
				</div>
			)}
		</section>
	)
}

const HEAD = "font-mono text-[10.5px] leading-[14px] tracking-[0.06em] text-muted-foreground/60 uppercase"
const NUM = "shrink-0 font-mono text-[12px] leading-4 tabular-nums"

/**
 * A model wears the colour of its band in the mix chart; a framework wears its
 * vendor's mark. Nothing else gets a glyph — a lane of generic marks would
 * indent every name without naming anything.
 */
function Glyph({
	dimension,
	row,
	modelMix,
}: {
	dimension: OverviewDimension
	row: OverviewBreakdownRow
	modelMix: OverviewModelMix
}) {
	if (dimension === "framework") {
		const Icon = vendorIcon(row.key)
		return <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
	}
	if (dimension !== "model") return null
	const band = modelMix.models.indexOf(row.key)
	return (
		<span
			aria-hidden
			className="size-[7px] shrink-0 rounded-[1px]"
			style={{
				backgroundColor:
					band === -1 ? "var(--muted-foreground)" : overviewModelMixColor(band, row.key),
			}}
		/>
	)
}

function UsageCells({ row, worstRate }: { row: OverviewBreakdownRow; worstRate: number }) {
	return (
		<>
			<ShareCell share={row.shareOfCost} className="w-[170px] @max-[900px]/table:hidden" />
			<span className={cn(NUM, "w-[84px] text-right text-foreground")}>
				{formatOverviewCount(row.sessions)}
			</span>
			<span className={cn(NUM, "w-[92px] text-right text-foreground @max-[700px]/table:hidden")}>
				{formatOverviewCount(row.llmCalls)}
			</span>
			<span className={cn(NUM, "w-[92px] text-right text-muted-foreground @max-[820px]/table:hidden")}>
				{formatNumber(row.tokensPerSession)}
			</span>
			<span className={cn(NUM, "w-[92px] text-right text-foreground")}>{formatCost(row.cost)}</span>
			<span className={cn(NUM, "w-[88px] text-right text-muted-foreground @max-[640px]/table:hidden")}>
				{formatCost(row.costPerSession)}
			</span>
			<RateCell rate={row.errorRate} worst={worstRate} />
			<DeltaCell pp={row.errorRateDeltaPp} />
		</>
	)
}

function ToolCells({ row, worstRate }: { row: OverviewBreakdownRow; worstRate: number }) {
	return (
		<>
			<ShareCell share={row.shareOfCalls} className="w-[170px] @max-[900px]/table:hidden" />
			<span className={cn(NUM, "w-[84px] text-right text-foreground")}>
				{formatOverviewCount(row.sessions)}
			</span>
			<span className={cn(NUM, "w-[92px] text-right text-foreground")}>
				{formatOverviewCount(row.toolCalls)}
			</span>
			<span className={cn(NUM, "w-[92px] text-right text-muted-foreground @max-[700px]/table:hidden")}>
				{formatOverviewCount(row.toolErrors)}
			</span>
			<RateCell rate={row.errorRate} worst={worstRate} />
			<DeltaCell pp={row.errorRateDeltaPp} />
		</>
	)
}

/** The row's share of what the table lists, drawn against the full width. */
function ShareCell({ share, className }: { share: number; className: string }) {
	return (
		<span className={cn("flex shrink-0 items-center gap-2.5", className)}>
			<span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-muted">
				<span
					className="block h-full rounded-[2px] bg-primary"
					style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
				/>
			</span>
			<span className="w-[46px] shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
				{formatPercent(share)}
			</span>
		</span>
	)
}

/**
 * The error rate, drawn against the WORST row rather than against 100%: a table
 * where every model fails under 3% would otherwise be a column of invisible
 * slivers, and ranking these rows against each other is the column's whole job.
 * The tone is absolute, so the colour still says how bad 3% is.
 */
function RateCell({ rate, worst }: { rate: number; worst: number }) {
	const tone = rate >= 0.1 ? "--severity-error" : rate >= 0.01 ? "--severity-warn" : "--severity-info"
	return (
		<span className="flex w-[116px] shrink-0 items-center justify-end gap-2">
			<span className="h-[5px] w-[54px] shrink-0 overflow-hidden rounded-[2px] bg-muted @max-[760px]/table:hidden">
				<span
					className="block h-full rounded-[2px]"
					style={{
						width: `${worst === 0 ? 0 : Math.max((rate / worst) * 100, rate > 0 ? 4 : 0)}%`,
						backgroundColor: `var(${tone})`,
					}}
				/>
			</span>
			<span className={cn(NUM, "w-[46px] text-right text-foreground")}>{formatErrorRate(rate)}</span>
		</span>
	)
}

/** A key with no previous window has no move to show, which is not a zero. */
function DeltaCell({ pp }: { pp: number | null }) {
	if (pp === null) {
		return (
			<span
				className={cn(NUM, "w-[86px] text-right text-muted-foreground/50 @max-[560px]/table:hidden")}
			>
				—
			</span>
		)
	}
	const flat = Math.abs(pp) < 0.05
	return (
		<span
			className={cn(
				NUM,
				"w-[86px] text-right @max-[560px]/table:hidden",
				flat
					? "text-muted-foreground/70"
					: pp > 0
						? "text-[var(--severity-error)]"
						: "text-[var(--severity-info)]",
			)}
		>
			{flat ? "0.0pp" : `${pp < 0 ? "-" : "+"}${Math.abs(pp).toFixed(1)}pp`}
		</span>
	)
}

/** What the listed rows add up to, as the closing line states it. */
function footerTotals(dimension: OverviewDimension, rows: ReadonlyArray<OverviewBreakdownRow>): string {
	const plural = rows.length === 1 ? dimension : `${dimension}s`
	if (dimension === "tool") {
		const calls = rows.reduce((sum, row) => sum + row.toolCalls, 0)
		return `${rows.length} ${plural} · ${formatOverviewCount(calls)} tool calls`
	}
	const calls = rows.reduce((sum, row) => sum + row.llmCalls, 0)
	const cost = rows.reduce((sum, row) => sum + row.cost, 0)
	return `${rows.length} ${plural} · ${formatOverviewCount(calls)} LLM calls · ${formatCost(cost)}`
}

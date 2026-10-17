// A Cloud SQL instance's top statements: Query Insights' figures, as the poller stored them, beside
// the traces' view of the same statement. The look of PlanetScale's top queries, as a table.

import { useState } from "react"

import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Meter } from "@maple/ui/components/ui/meter"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { EMPTY_VALUE, formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable } from "@/components/common/data-table"
import { ErrorState } from "@/components/common/error-state"
import { SectionHeading } from "@/components/common/section-heading"
import { Result } from "@/lib/effect-atom"

import type { GcpStatement, GcpTopQueries, GcpTracedStatement } from "./cloud-sql-signals"

const SHOWN = 5
const STATEMENT = "w-0 min-w-[260px] flex-1"
const NUMBER = "text-right font-mono text-xs tabular-nums"
const SUB = "truncate font-mono text-3xs text-muted-foreground"

/** Rows read per call from here: a scan, not a lookup. */
const MANY_ROWS = 10_000
/** Lock wait from these shares of a statement's time: contention, then a queue. */
const LOCK_WARN = 0.2
const LOCK_CRIT = 0.5
/** The app's p95 this many times the database's: the time went somewhere else. */
const APP_GAP = 5

function Columns() {
	return (
		<>
			<ColumnHead label="Statement" width={STATEMENT} />
			<ColumnHead label="Calls" align="right" width="w-[64px]" />
			<ColumnHead label="DB p95" align="right" width="w-[72px]" />
			<ColumnHead label="App p95" align="right" width="w-[72px]" />
			<ColumnHead label="Rows" align="right" width="w-[64px]" hidden="hidden md:flex" />
			<ColumnHead label="Lock" align="right" width="w-[56px]" />
			<ColumnHead label="Total time" width="w-[112px]" hidden="hidden md:flex" />
		</>
	)
}

/** Who ran it: the traced services, when the traces recorded it. */
function Callers({ traced }: { traced: GcpTracedStatement | undefined }) {
	if (traced === undefined) return <div className={cn(SUB, TONE_TEXT.warn)}>not traced</div>
	const more = traced.serviceCount - traced.services.length
	return (
		<div className={SUB}>
			called by {traced.services.join(" · ")}
			{more > 0 ? ` +${more}` : ""}
		</div>
	)
}

function StatementRow({ row, traced }: { row: GcpStatement; traced: GcpTracedStatement | undefined }) {
	const rowsPerCall = row.calls > 0 ? row.rows / row.calls : undefined
	const db = row.p95LatencyMillis
	const app = traced?.appP95Ms
	return (
		<div className="flex items-center gap-4 border-b border-border/40 px-4 py-2.5 last:border-0">
			<div className={cn(STATEMENT, "space-y-0.5")}>
				<div className="truncate font-mono text-xs text-foreground" title={row.querystring}>
					{row.querystring}
				</div>
				<Callers traced={traced} />
			</div>
			<div className={cn("w-[64px] text-foreground/80", NUMBER)}>{formatNumber(row.calls)}</div>
			<div
				className={cn(
					"w-[72px]",
					NUMBER,
					db === null ? "text-muted-foreground" : latencyToneClass(db),
				)}
			>
				{db === null ? EMPTY_VALUE : formatLatency(db)}
			</div>
			<div
				className={cn(
					"w-[72px]",
					NUMBER,
					app === undefined
						? "text-muted-foreground"
						: db !== null && app >= APP_GAP * db
							? TONE_TEXT.crit
							: latencyToneClass(app),
				)}
			>
				{app === undefined ? EMPTY_VALUE : formatLatency(app)}
			</div>
			<div
				className={cn(
					"hidden w-[64px] md:block",
					NUMBER,
					(rowsPerCall ?? 0) >= MANY_ROWS ? TONE_TEXT.warn : "text-foreground/80",
				)}
			>
				{rowsPerCall === undefined ? EMPTY_VALUE : formatNumber(Math.round(rowsPerCall))}
			</div>
			<div
				className={cn(
					"w-[56px]",
					NUMBER,
					row.lockShare >= LOCK_CRIT
						? TONE_TEXT.crit
						: row.lockShare >= LOCK_WARN
							? TONE_TEXT.warn
							: "text-muted-foreground",
				)}
			>
				{formatPercent(row.lockShare)}
			</div>
			<div className="hidden w-[112px] items-center gap-2 md:flex">
				<Meter value={row.executionShare} tone="neutral" className="w-14" />
				<span className="font-mono text-2xs tabular-nums text-foreground/80">
					{formatPercent(row.executionShare)}
				</span>
			</div>
		</div>
	)
}

/** Bordered like the rows, so an explanation keeps the section's rhythm. */
function Notice({ children }: { children: React.ReactNode }) {
	return (
		<EmptyMessage dashed className="bg-card/50 px-3 py-4 text-xs">
			{children}
		</EmptyMessage>
	)
}

/**
 * The instance's statements by total execution time. A reason Query Insights can't answer (off,
 * not PostgreSQL) reads as information, not a failure.
 */
export function GcpCloudSqlTopQueries({
	insights,
	traced,
}: {
	insights: Result.Result<GcpTopQueries, unknown>
	/** The traced side of each statement, by `queryHash`. */
	traced: ReadonlyMap<string, GcpTracedStatement>
}) {
	const [all, setAll] = useState(false)
	const body = () => {
		if (Result.isInitial(insights)) {
			return <SkeletonList rows={3} rowClassName="h-[48px] rounded-md" className="gap-1.5" />
		}
		if (Result.isFailure(insights)) {
			return (
				<ErrorState error={insights.cause} title="Query Insights is unavailable" variant="inline" />
			)
		}
		const { rows, unavailableReason } = insights.value
		if (unavailableReason !== null) return <Notice>{unavailableReason}</Notice>
		if (rows.length === 0) return <Notice>Query Insights recorded no statements in this window.</Notice>
		const shown = all ? rows : rows.slice(0, SHOWN)
		return (
			<DataTable.Root ariaLabel="Top queries" waiting={insights.waiting}>
				<DataTable.Head>
					<Columns />
				</DataTable.Head>
				{shown.map((row) => (
					<StatementRow key={row.queryHash} row={row} traced={traced.get(row.queryHash)} />
				))}
				<div className="flex items-center justify-between gap-4 px-4 py-2.5 font-mono text-2xs text-muted-foreground">
					<span>
						{rows.length > shown.length ? `${rows.length - shown.length} more · ` : ""}rows = rows
						per call · lock = share of DB time waiting on locks
					</span>
					{rows.length > SHOWN ? (
						<button
							type="button"
							onClick={() => setAll(!all)}
							className="shrink-0 text-primary hover:text-primary/80"
						>
							{all ? "Show fewer" : `Show all ${rows.length}`}
						</button>
					) : null}
				</div>
			</DataTable.Root>
		)
	}
	return (
		<section className="space-y-3">
			<SectionHeading title="Top queries" hint="by total time, Query Insights and traces" />
			{body()}
		</section>
	)
}

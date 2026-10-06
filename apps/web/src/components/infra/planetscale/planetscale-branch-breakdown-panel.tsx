import { useMemo, useState } from "react"

import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable, MetaChip, useTableSort } from "@/components/common/data-table"
import { SegmentPivot } from "../primitives/segment-pivot"
import { relativeRatio, shareBar } from "../primitives/share-bar"
import type { BranchCandidate } from "./branch-selection"
import { BRANCH_STATE_LABEL, branchStateOf } from "./filters"
import { MISSING, formatLag, formatStoragePercent, lagClass, utilizationClass } from "./metrics"

/**
 * Per-branch breakdown for one database — which branch is actually consuming
 * the connections, the CPU, the disk.
 *
 * Replaces the separate branch table rather than sitting next to it: that table
 * was already a ranked per-branch list with click-to-scope, and two ranked
 * branch tables on one page is debt this refactor should not create.
 *
 * The measure switcher is the interesting part. Connections are additive, so a
 * branch's *share of the database* is a real number. CPU, memory, storage and
 * lag are maxima, and **you cannot sum maxima** — a "share of total peak CPU"
 * would be a statistic that corresponds to nothing. Those measures rank against
 * the worst branch instead, and the footer says which comparison is on screen.
 */

type Measure = "connections" | "cpu" | "memory" | "storage" | "lag"

interface MeasureSpec {
	readonly label: string
	readonly of: (candidate: BranchCandidate) => number
	readonly format: (value: number) => string
	readonly className?: (value: number) => string | undefined
	/**
	 * Whether the values sum to a meaningful total. False for maxima — see the
	 * note above; this is what picks the tint basis and the footer copy.
	 */
	readonly additive: boolean
}

const MEASURES: Record<Measure, MeasureSpec> = {
	connections: {
		label: "Connections",
		of: (c) => c.stat?.connectionsAvg ?? MISSING,
		format: (v) => formatNumber(v),
		additive: true,
	},
	cpu: {
		label: "CPU (max)",
		of: (c) => c.stat?.cpuMaxPercent ?? MISSING,
		format: (v) => `${v.toFixed(0)}%`,
		className: utilizationClass,
		additive: false,
	},
	memory: {
		label: "Memory (max)",
		of: (c) => c.stat?.memMaxPercent ?? MISSING,
		format: (v) => `${v.toFixed(0)}%`,
		className: utilizationClass,
		additive: false,
	},
	storage: {
		label: "Storage",
		of: (c) => c.stat?.storageUsedPercent ?? MISSING,
		format: formatStoragePercent,
		className: utilizationClass,
		additive: false,
	},
	lag: {
		label: "Replica lag (max)",
		of: (c) => c.stat?.replicaLagMaxSeconds ?? MISSING,
		format: formatLag,
		className: lagClass,
		additive: false,
	},
} satisfies Record<Measure, MeasureSpec>

const MEASURE_ORDER: ReadonlyArray<Measure> = ["connections", "cpu", "memory", "storage", "lag"]

/** Beyond this the tail is noise; it folds into one "Other" row. */
const TOP_N = 8

type SortKey = "branch" | "value"

interface Row {
	readonly branch: string
	readonly production: boolean
	readonly state: ReturnType<typeof branchStateOf>
	readonly value: number
	readonly hasValue: boolean
	readonly ratio: number
	readonly isOther: boolean
	readonly otherCount: number
}

export function PlanetScaleBranchBreakdownPanel({
	candidates,
	selectedBranches,
	onToggleBranch,
	waiting,
	emptyMessage = "No branches match these filters.",
}: {
	candidates: ReadonlyArray<BranchCandidate>
	selectedBranches: ReadonlyArray<string>
	onToggleBranch: (branch: string) => void
	waiting?: boolean
	emptyMessage?: string
}) {
	const [measure, setMeasure] = useState<Measure>("connections")
	const spec = MEASURES[measure]

	const { rows, total, max } = useMemo(() => {
		const scored = candidates.map((candidate) => ({
			candidate,
			value: spec.of(candidate),
			hasValue: spec.of(candidate) !== MISSING,
		}))
		// Missing values sort last, never as zero — a branch with no samples is
		// not a quiet branch.
		const ordered = [...scored].sort((a, b) => {
			if (a.hasValue !== b.hasValue) return a.hasValue ? -1 : 1
			return b.value - a.value || a.candidate.name.localeCompare(b.candidate.name)
		})
		const withValues = ordered.filter((entry) => entry.hasValue)
		const sum = withValues.reduce((acc, entry) => acc + entry.value, 0)
		const peak = withValues.reduce((acc, entry) => Math.max(acc, entry.value), 0)
		const basis = spec.additive ? sum : peak

		const head = ordered.slice(0, TOP_N)
		const tail = ordered.slice(TOP_N)
		const built: Row[] = head.map((entry) => ({
			branch: entry.candidate.name,
			production: entry.candidate.production,
			state: branchStateOf(entry.candidate),
			value: entry.value,
			hasValue: entry.hasValue,
			ratio: entry.hasValue ? relativeRatio(entry.value, basis) : 0,
			isOther: false,
			otherCount: 0,
		}))

		if (tail.length > 0) {
			const tailWithValues = tail.filter((entry) => entry.hasValue)
			// "Other" only carries a number when the measure is additive — summing
			// the tail's peak CPU would invent a value nothing measured.
			const otherValue = spec.additive
				? tailWithValues.reduce((acc, entry) => acc + entry.value, 0)
				: MISSING
			built.push({
				branch: `Other (${tail.length} branch${tail.length === 1 ? "" : "es"})`,
				production: false,
				state: "ready",
				value: otherValue,
				hasValue: spec.additive && tailWithValues.length > 0,
				ratio: spec.additive ? relativeRatio(otherValue, basis) : 0,
				isOther: true,
				otherCount: tail.length,
			})
		}
		return { rows: built, total: sum, max: peak }
	}, [candidates, spec])

	const { sorted, sortKey, sortDir, handleSort } = useTableSort<Row, SortKey>(rows, {
		initialKey: "value",
		stringKeys: ["branch"],
		// The Other row is an aggregate, not a peer — it stays at the bottom.
		pinned: (row) => !row.isOther && row.production,
	})

	return (
		<Panel className="border-border/60">
			<PanelHeader
				title="Branches"
				className="border-border/60 px-3 py-2"
				action={
					<SegmentPivot<Measure>
						ariaLabel="Measure"
						options={MEASURE_ORDER.map((key) => ({ value: key, label: MEASURES[key].label }))}
						value={measure}
						onChange={setMeasure}
					/>
				}
			/>

			<DataTable.Root ariaLabel="PlanetScale branch breakdown" waiting={waiting} maxHeight={420}>
				<DataTable.Head>
					<ColumnHead<SortKey>
						label="Branch"
						sortKey="branch"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="w-0 flex-1 min-w-[200px]"
					/>
					<ColumnHead<SortKey>
						label={spec.label}
						sortKey="value"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[120px]"
					/>
				</DataTable.Head>
				{sorted.length === 0 && <DataTable.Empty>{emptyMessage}</DataTable.Empty>}

				{sorted.map((row) => {
					const selected = !row.isOther && selectedBranches.includes(row.branch)
					const Cell = (
						<>
							<div className="flex w-0 min-w-[200px] flex-1 items-center gap-2 overflow-hidden">
								<span
									className={cn(
										"truncate text-sm",
										row.isOther
											? "text-muted-foreground"
											: "font-mono text-foreground/90",
										selected && "text-primary",
									)}
								>
									{row.branch}
								</span>
								{row.production ? <MetaChip>production</MetaChip> : null}
								{!row.isOther && row.state !== "ready" ? (
									<MetaChip>{BRANCH_STATE_LABEL[row.state].toLowerCase()}</MetaChip>
								) : null}
							</div>
							<div
								className={cn(
									"w-[120px] text-right font-mono text-xs tabular-nums text-foreground/80",
									row.hasValue && spec.className?.(row.value),
								)}
							>
								{row.hasValue ? spec.format(row.value) : "—"}
							</div>
						</>
					)

					// The Other row aggregates branches with no single identity, so it
					// isn't a filter target.
					if (row.isOther) {
						return (
							<div
								key="__other"
								className="flex items-center gap-3 px-3 py-1.5"
								style={shareBar(row.ratio)}
							>
								{Cell}
							</div>
						)
					}
					return (
						<button
							key={row.branch}
							type="button"
							aria-pressed={selected}
							title={`Filter to ${row.branch}`}
							onClick={() => onToggleBranch(row.branch)}
							className={cn(
								"flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
								selected && "bg-muted/40",
							)}
							style={shareBar(row.ratio)}
						>
							{Cell}
						</button>
					)
				})}
			</DataTable.Root>

			<div className="border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
				{spec.additive
					? `Bars show share of ${formatNumber(total)} total across ${countLabel(candidates.length, "branch", "branches")}.`
					: // Not "% of database": these are maxima, and they do not sum.
						`Bars are relative to the worst branch (${spec.format(max)}). Peaks don't sum, so there is no database total.`}
			</div>
		</Panel>
	)
}

export function PlanetScaleBranchBreakdownPanelLoading() {
	return (
		<Panel className="border-border/60">
			<PanelHeader className="border-border/60 px-3 py-2">
				<Skeleton className="h-4 w-56" />
			</PanelHeader>
			<SkeletonList rows={5} rowClassName="h-4" gap="2" className="p-3" />
		</Panel>
	)
}

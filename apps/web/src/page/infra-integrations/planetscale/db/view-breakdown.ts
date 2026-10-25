import type { BranchCandidate } from "../../../../components/infra/planetscale/branch-selection"
import { countLabel, EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { panel, panelHeader } from "../../../../ui/panel"
import { segmentedSelect } from "../../../../ui/segmented-select"
import { skeleton, skeletonList } from "../../../../ui/skeleton"
import { columnHead, dataTable, dataTableEmpty } from "../../../infra/kit/data-table"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import { BRANCH_STATE_LABEL, branchStateOf, type BranchState } from "../filters"
import {
	formatLag,
	formatStoragePercent,
	formatWholePercent,
	lagClass,
	MISSING,
	utilizationClass,
} from "../metrics"
import { type BreakdownSortKey, type Measure, Message } from "./model"

// `PlanetScaleBranchBreakdownPanel`.

type H = HtmlBuilder<Message>

interface MeasureSpec {
	readonly label: string
	readonly of: (candidate: BranchCandidate) => number
	readonly format: (value: number) => string
	readonly className?: (value: number) => string | undefined
	readonly additive: boolean
}

const MEASURES = {
	connections: {
		label: "Connections",
		of: (c) => c.stat?.connectionsAvg ?? MISSING,
		format: formatNumber,
		additive: true,
	},
	cpu: {
		label: "CPU (max)",
		of: (c) => c.stat?.cpuMaxPercent ?? MISSING,
		format: (v) => formatWholePercent(v / 100),
		className: utilizationClass,
		additive: false,
	},
	memory: {
		label: "Memory (max)",
		of: (c) => c.stat?.memMaxPercent ?? MISSING,
		format: (v) => formatWholePercent(v / 100),
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
} as const satisfies Record<Measure, MeasureSpec>

const MEASURE_ORDER: ReadonlyArray<Measure> = ["connections", "cpu", "memory", "storage", "lag"]
const TOP_N = 8

interface Row {
	readonly branch: string
	readonly production: boolean
	readonly state: BranchState
	readonly value: number
	readonly hasValue: boolean
	readonly ratio: number
	readonly isOther: boolean
}

/** `relativeRatio`. */
const relativeRatio = (value: number, max: number): number =>
	max > 0 && Number.isFinite(value) ? Math.max(0, value) / max : 0

/** `shareBar`: the row's background filled to its share. */
export const shareBarStyle = (share: number): Readonly<Record<string, string>> | undefined => {
	const pct = Math.min(100, share * 100)
	if (!Number.isFinite(pct) || pct < 0.5) return undefined
	const fill = "color-mix(in oklab, var(--primary) 14%, transparent)"
	return {
		"background-image": `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, transparent ${pct}%)`,
	}
}

const rowsOf = (candidates: ReadonlyArray<BranchCandidate>, spec: MeasureSpec) => {
	const scored = candidates.map((candidate) => ({
		candidate,
		value: spec.of(candidate),
		hasValue: spec.of(candidate) !== MISSING,
	}))
	const ordered = [...scored].sort((a, b) =>
		a.hasValue !== b.hasValue
			? a.hasValue
				? -1
				: 1
			: b.value - a.value || a.candidate.name.localeCompare(b.candidate.name),
	)
	const withValues = ordered.filter((entry) => entry.hasValue)
	const total = withValues.reduce((acc, entry) => acc + entry.value, 0)
	const max = withValues.reduce((acc, entry) => Math.max(acc, entry.value), 0)
	const basis = spec.additive ? total : max
	const tail = ordered.slice(TOP_N)
	const tailValues = tail.filter((entry) => entry.hasValue)
	const otherValue = spec.additive ? tailValues.reduce((acc, entry) => acc + entry.value, 0) : MISSING
	const rows: ReadonlyArray<Row> = [
		...ordered.slice(0, TOP_N).map((entry) => ({
			branch: entry.candidate.name,
			production: entry.candidate.production,
			state: branchStateOf(entry.candidate),
			value: entry.value,
			hasValue: entry.hasValue,
			ratio: entry.hasValue ? relativeRatio(entry.value, basis) : 0,
			isOther: false,
		})),
		...(tail.length === 0
			? []
			: [
					{
						branch: `Other (${tail.length} branch${tail.length === 1 ? "" : "es"})`,
						production: false,
						state: "ready" as const,
						value: otherValue,
						hasValue: spec.additive && tailValues.length > 0,
						ratio: spec.additive ? relativeRatio(otherValue, basis) : 0,
						isOther: true,
					},
				]),
	]
	return { rows, total, max }
}

const metaChip = (h: H, text: string): Html =>
	h.span([h.Class("font-mono text-3xs text-muted-foreground/80")], [text])

const cells = (h: H, row: Row, spec: MeasureSpec, isSelected: boolean): ReadonlyArray<Html> => [
	h.div(
		[h.Class("flex w-0 min-w-[200px] flex-1 items-center gap-2 overflow-hidden")],
		[
			h.span(
				[
					h.Class(
						cn(
							"truncate text-sm",
							row.isOther ? "text-muted-foreground" : "font-mono text-foreground/90",
							isSelected && "text-primary",
						),
					),
				],
				[row.branch],
			),
			...(row.production ? [metaChip(h, "production")] : []),
			...(!row.isOther && row.state !== "ready"
				? [metaChip(h, BRANCH_STATE_LABEL[row.state].toLowerCase())]
				: []),
		],
	),
	h.div(
		[
			h.Class(
				cn(
					"w-[120px] text-right font-mono text-xs tabular-nums text-foreground/80",
					row.hasValue && spec.className?.(row.value),
				),
			),
		],
		[row.hasValue ? spec.format(row.value) : EMPTY_VALUE],
	),
]

export type BreakdownInputs = Readonly<{
	candidates: ReadonlyArray<BranchCandidate>
	selectedBranches: ReadonlyArray<string>
	measure: Measure
	sort: Sort<BreakdownSortKey>
	isWaiting: boolean
	emptyMessage: string
}>

const toSortRow = (row: Row) => ({ ...row, branch: row.branch, value: row.value })

export const breakdownPanel = (h: H, inputs: BreakdownInputs): Html => {
	const spec: MeasureSpec = MEASURES[inputs.measure]
	const { rows, total, max } = rowsOf(inputs.candidates, spec)
	const sorted = sortRowsByField(rows.map(toSortRow), inputs.sort, (row) => !row.isOther && row.production)
	return panel(h, { className: "border-border/60" }, [
		panelHeader(h, {
			title: "Branches",
			className: "border-border/60 px-3 py-2",
			action: segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Measure",
				options: MEASURE_ORDER.map((key) => ({ value: key, label: MEASURES[key].label })),
				value: inputs.measure,
				onChange: (measure) => Message.ClickedMeasure({ measure }),
			}),
		}),
		dataTable(
			h,
			{ ariaLabel: "PlanetScale branch breakdown", isWaiting: inputs.isWaiting, maxHeight: "420px" },
			[
				columnHead(h, {
					label: "Branch",
					width: "w-0 flex-1 min-w-[200px]",
					sort: {
						onSort: Message.ClickedBreakdownSort({ key: "branch" }),
						isActive: inputs.sort.key === "branch",
						dir: inputs.sort.dir,
					},
				}),
				columnHead(h, {
					label: spec.label,
					width: "w-[120px]",
					align: "right",
					sort: {
						onSort: Message.ClickedBreakdownSort({ key: "value" }),
						isActive: inputs.sort.key === "value",
						dir: inputs.sort.dir,
					},
				}),
			],
			sorted.length === 0
				? [dataTableEmpty(h, [inputs.emptyMessage])]
				: sorted.map((row) => {
						const style = shareBarStyle(row.ratio)
						const styleAttrs = style === undefined ? [] : [h.Style(style)]
						if (row.isOther) {
							return h.div(
								[h.Class("flex items-center gap-3 px-3 py-1.5"), ...styleAttrs],
								cells(h, row, spec, false),
							)
						}
						const isSelected = inputs.selectedBranches.includes(row.branch)
						return h.button(
							[
								h.AriaPressed(String(isSelected)),
								h.Class(
									cn(
										"flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
										isSelected && "bg-muted/40",
									),
								),
								...styleAttrs,
								h.Title(`Filter to ${row.branch}`),
								h.Type("button"),
								h.OnClick(Message.ToggledBranch({ branch: row.branch })),
							],
							cells(h, row, spec, isSelected),
						)
					}),
		),
		h.div(
			[h.Class("border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground")],
			[
				spec.additive
					? `Bars show share of ${formatNumber(total)} total across ${countLabel(inputs.candidates.length, "branch", "branches")}.`
					: `Bars are relative to the worst branch (${spec.format(max)}). Peaks don't sum, so there is no database total.`,
			],
		),
	])
}

export const breakdownLoading = (h: H): Html =>
	panel(h, { className: "border-border/60" }, [
		panelHeader(h, { className: "border-border/60 px-3 py-2", children: [skeleton(h, "h-4 w-56")] }),
		skeletonList(h, { rows: 5, rowClassName: "h-4", gap: "2", className: "p-3" }),
	])

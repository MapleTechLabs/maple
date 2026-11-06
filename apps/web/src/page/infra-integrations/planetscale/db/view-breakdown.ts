import type { BranchCandidate } from "../../../../components/infra/planetscale/branch-selection"
import { countLabel, EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pressable } from "@maple/views/ui/pressable"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import { columnHead, dataTable, dataTableEmpty } from "../../../infra/kit/data-table"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import { BRANCH_STATE_LABEL, branchStateOf, type BranchState } from "../filters"
import {
	formatLag,
	formatStoragePercent,
	lagClass,
	MISSING,
	utilizationClass,
} from "../../../../components/infra/planetscale/metrics"
import { formatWholePercent } from "../../../../components/infra/format"
import { type BreakdownSortKey, type Measure, Message } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { columnClass } from "@maple/views/ui/column"
import { Array as Arr, String as Str } from "effect"

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
	const scored = Arr.map(candidates, (candidate) => ({
		candidate,
		value: spec.of(candidate),
		hasValue: spec.of(candidate) !== MISSING,
	}))
	type Scored = (typeof scored)[number]
	const ordered = Arr.sort(scored, (a: Scored, b: Scored) => {
		if (a.hasValue !== b.hasValue) return a.hasValue ? -1 : 1
		const diff = b.value - a.value
		return diff > 0 ? 1 : diff < 0 ? -1 : Str.localeCompare(b.candidate.name)(a.candidate.name)
	})
	const withValues = Arr.filter(ordered, (entry) => entry.hasValue)
	const total = Arr.reduce(withValues, 0, (acc, entry) => acc + entry.value)
	const max = Arr.reduce(withValues, 0, (acc, entry) => Math.max(acc, entry.value))
	const basis = spec.additive ? total : max
	const tail = ordered.slice(TOP_N)
	const tailValues = Arr.filter(tail, (entry) => entry.hasValue)
	const otherValue = spec.additive ? Arr.reduce(tailValues, 0, (acc, entry) => acc + entry.value) : MISSING
	const rows: ReadonlyArray<Row> = [
		...Arr.map(ordered.slice(0, TOP_N), (entry) => ({
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
	typography(h, { size: "3xs", tone: "subtle", mono: true }, [text])

const cells = (h: H, row: Row, spec: MeasureSpec, isSelected: boolean): ReadonlyArray<Html> => [
	h.div(
		[h.Class("flex w-0 min-w-52 flex-1 items-center gap-2 overflow-hidden")],
		[
			h.span(
				[
					h.Class(
						cn(
							typographyClass({ size: "sm", truncate: true }),
							row.isOther ? "text-muted-foreground" : "font-mono text-foreground-soft",
							isSelected && "text-primary",
						),
					),
				],
				[row.branch],
			),
			...(row.production ? [metaChip(h, "production")] : []),
			...(!row.isOther && row.state !== "ready"
				? [metaChip(h, Str.toLowerCase(BRANCH_STATE_LABEL[row.state]))]
				: []),
		],
	),
	h.div(
		[
			h.Class(
				cn(
					"w-32 text-right font-mono text-xs tabular-nums text-foreground-soft",
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
	const sortRows = Arr.map(rows, toSortRow)
	const sorted = sortRowsByField(sortRows, inputs.sort, (row) => !row.isOther && row.production)
	return panel(h, { className: "border-border-subtle" }, [
		panelHeader(h, {
			title: "Branches",
			className: "border-border-subtle px-3 py-2",
			action: segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Measure",
				options: Arr.map(MEASURE_ORDER, (key) => ({ value: key, label: MEASURES[key].label })),
				value: inputs.measure,
				onChange: (measure) => Message.ClickedMeasure({ measure }),
			}),
		}),
		dataTable(
			h,
			{ ariaLabel: "PlanetScale branch breakdown", isWaiting: inputs.isWaiting },
			[
				columnHead(h, {
					label: "Branch",
					width: columnClass({ min: "52" }),
					sort: {
						onSort: Message.ClickedBreakdownSort({ key: "branch" }),
						isActive: inputs.sort.key === "branch",
						dir: inputs.sort.dir,
					},
				}),
				columnHead(h, {
					label: spec.label,
					width: "w-32",
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
				: Arr.map(sorted, (row) => {
						const style = shareBarStyle(row.ratio)
						const styleAttrs = style === undefined ? [] : [h.Style(style)]
						if (row.isOther) {
							return h.div(
								[h.Class("flex items-center gap-3 px-3 py-1.5"), ...styleAttrs],
								cells(h, row, spec, false),
							)
						}
						const isSelected = inputs.selectedBranches.includes(row.branch)
						return pressable(
							h,
							{
								onClick: Message.ToggledBranch({ branch: row.branch }),
								isSelected,
								className: cn(
									"flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-surface-sunken active:bg-surface-sunken",
									isSelected && "bg-surface-strong",
								),
								attributes: [...styleAttrs, h.Title(`Filter to ${row.branch}`)],
							},
							cells(h, row, spec, isSelected),
						)
					}),
		),
		h.div(
			[h.Class("border-t border-border-subtle px-3 py-1.5 text-2xs text-muted-foreground")],
			[
				spec.additive
					? `Bars show share of ${formatNumber(total)} total across ${countLabel(inputs.candidates.length, "branch", "branches")}.`
					: `Bars are relative to the worst branch (${spec.format(max)}). Peaks don't sum, so there is no database total.`,
			],
		),
	])
}

export const breakdownLoading = (h: H): Html =>
	panel(h, { className: "border-border-subtle" }, [
		panelHeader(h, { className: "border-border-subtle px-3 py-2", children: [skeleton(h, "h-4 w-56")] }),
		skeletonList(h, { rows: 5, rowClassName: "h-4", gap: "2", className: "p-3" }),
	])

import {
	asFiniteNumber,
	type BreakdownRow,
	pickValueField,
	toBreakdownRows,
} from "@maple/ui/components/charts/_shared/breakdown-rows"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

// The stage derivation of `FunnelBarsChart` (packages/ui/src/components/charts/funnel/
// query-builder-funnel-chart.tsx): rows folded into stages, grouped rows into one bar per group.

export interface StageGroup {
	readonly name: string
	readonly color: string
	readonly value: number
	readonly widthPct: number
	readonly pctOfFirst: number
}

export interface Stage extends BreakdownRow {
	readonly color: string
	readonly widthPct: number
	readonly pctOfFirst: number
	readonly pctOfPrev: number | null
	readonly groups: ReadonlyArray<StageGroup>
}

const BAR_MIN_PCT = 0.04

/** `dropTrailingZeroRows`: keep one zero stage right after the last non-zero one. */
export const dropTrailingZeroRows = <T extends BreakdownRow>(rows: ReadonlyArray<T>): ReadonlyArray<T> => {
	const lastNonZero = rows.findLastIndex((row) => row.value > 0)
	return rows.slice(0, Math.min(rows.length, lastNonZero + 2))
}

type Row = Readonly<Record<string, unknown>>
type GroupedStage = BreakdownRow & { readonly byGroup: ReadonlyMap<string, number> }

const isGroupedRow = (row: Row): boolean => typeof row.group === "string"

const toGroupedStages = (source: ReadonlyArray<Row>, valueField: string) => {
	const groups = [...new Set(source.map((row) => String(row.group)))]
	const order: Array<string> = []
	const byName = new Map<string, { unnamed: boolean; value: number; byGroup: Map<string, number> }>()
	source.forEach((row) => {
		const raw = row.name === null || row.name === undefined ? "" : String(row.name).trim()
		const name = raw === "" ? "(no value)" : raw
		const existing = byName.get(name)
		const stage = existing ?? { unnamed: raw === "", value: 0, byGroup: new Map<string, number>() }
		if (existing === undefined) {
			byName.set(name, stage)
			order.push(name)
		}
		const value = asFiniteNumber(row[valueField])
		const group = String(row.group)
		stage.byGroup.set(group, (stage.byGroup.get(group) ?? 0) + value)
		stage.value += value
	})
	const stages: ReadonlyArray<GroupedStage> = order.flatMap((name) => {
		const stage = byName.get(name)
		return stage === undefined ? [] : [{ name, ...stage }]
	})
	return { stages, groups }
}

export type FunnelStages = Readonly<{
	stages: ReadonlyArray<Stage>
	legend: ReadonlyArray<{ readonly name: string; readonly color: string }>
}>

const groupedFunnel = (source: ReadonlyArray<Row>, valueField: string): FunnelStages => {
	const { stages: folded, groups } = toGroupedStages(source, valueField)
	const rows = dropTrailingZeroRows(folded)
	const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
	const first = rows[0]
	if (max <= 0 || first === undefined) return { stages: [], legend: [] }
	const groupMax = rows.reduce(
		(acc, r) => Math.max(acc, ...groups.map((group) => r.byGroup.get(group) ?? 0)),
		0,
	)
	const colors = resolveSeriesColors(groups)
	return {
		legend: groups.map((name) => ({ name, color: colors.get(name) ?? "" })),
		stages: rows.map((row, idx): Stage => {
			const prev = rows[idx - 1]?.value
			return {
				name: row.name,
				unnamed: row.unnamed,
				value: row.value,
				color: "",
				widthPct: Math.max(BAR_MIN_PCT, row.value / max),
				pctOfFirst: first.value > 0 ? row.value / first.value : 0,
				pctOfPrev: idx === 0 || prev === undefined || prev <= 0 ? null : row.value / prev,
				groups: groups.map((group): StageGroup => {
					const value = row.byGroup.get(group) ?? 0
					const groupFirst = first.byGroup.get(group) ?? 0
					return {
						name: group,
						color: colors.get(group) ?? "",
						value,
						widthPct: groupMax > 0 ? Math.max(value > 0 ? BAR_MIN_PCT : 0, value / groupMax) : 0,
						pctOfFirst: groupFirst > 0 ? value / groupFirst : 0,
					}
				}),
			}
		}),
	}
}

/** The `stages` / `legend` memo. */
export const funnelStages = (source: ReadonlyArray<Row>): FunnelStages => {
	const valueField = pickValueField(source)
	const grouped = source.filter(isGroupedRow)
	if (grouped.length > 0 && grouped.length === source.length) return groupedFunnel(grouped, valueField)
	const rows = dropTrailingZeroRows(toBreakdownRows(source, valueField))
	const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
	const first = rows[0]?.value ?? 0
	if (max <= 0) return { stages: [], legend: [] }
	const colors = resolveSeriesColors(rows.map((row) => row.name))
	return {
		legend: [],
		stages: rows.map((row, idx): Stage => {
			const prev = rows[idx - 1]?.value
			return {
				...row,
				color: colors.get(row.name) ?? "",
				widthPct: Math.max(BAR_MIN_PCT, row.value / max),
				pctOfFirst: first > 0 ? row.value / first : 0,
				pctOfPrev: idx === 0 || prev === undefined || prev <= 0 ? null : row.value / prev,
				groups: [],
			}
		}),
	}
}

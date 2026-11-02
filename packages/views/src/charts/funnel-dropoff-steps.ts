import { asFiniteNumber, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

// The step derivation of `FunnelDropoffChart` (packages/ui/src/components/charts/funnel/
// funnel-dropoff-chart.tsx): one column per step, with timing and leavers when the route sends them.

export interface Leaver {
	readonly name: string
	readonly count: number
}

export interface Step {
	readonly name: string
	readonly unnamed: boolean
	readonly value: number
	readonly ofFirst: number
	readonly ofPrev: number | null
	readonly dropped: number
	readonly p50Ms?: number | undefined
	readonly p90Ms?: number | undefined
	readonly leavers: ReadonlyArray<Leaver>
	readonly groups: ReadonlyArray<{ name: string; color: string; value: number; prev: number }>
}

const LEAVERS_SHOWN = 4
const ENDED_LABEL = "Nothing after"

type Row = Readonly<Record<string, unknown>>

/** `fmtSpan`: coarse, human durations. */
export const fmtSpan = (ms: number): string => {
	if (!Number.isFinite(ms) || ms <= 0) return EMPTY_VALUE
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.round(s / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

const isRecord = (entry: unknown): entry is Row => typeof entry === "object" && entry !== null

const toLeavers = (value: unknown): ReadonlyArray<Leaver> =>
	Array.isArray(value)
		? value
				.filter(isRecord)
				.map((entry) => ({
					name: typeof entry.name === "string" ? entry.name : "",
					count: asFiniteNumber(entry.count),
				}))
				.filter((entry) => entry.count > 0)
		: []

const optionalNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const groupedSteps = (rows: ReadonlyArray<Row>, valueField: string) => {
	const groups = [...new Set(rows.map((row) => String(row.group)))]
	const order: Array<string> = []
	const byName = new Map<string, { value: number; byGroup: Map<string, number> }>()
	rows.forEach((row) => {
		const raw = row.name === null || row.name === undefined ? "" : String(row.name).trim()
		const name = raw === "" ? "(no value)" : raw
		const existing = byName.get(name)
		const step = existing ?? { value: 0, byGroup: new Map<string, number>() }
		if (existing === undefined) {
			byName.set(name, step)
			order.push(name)
		}
		const value = asFiniteNumber(row[valueField])
		const group = String(row.group)
		step.byGroup.set(group, (step.byGroup.get(group) ?? 0) + value)
		step.value += value
	})
	const colors = resolveSeriesColors(groups)
	const first = byName.get(order[0] ?? "")?.value ?? 0
	const steps = order.map((name, index): Step => {
		const step = byName.get(name) ?? { value: 0, byGroup: new Map<string, number>() }
		const prev = index > 0 ? byName.get(order[index - 1] ?? "") : undefined
		return {
			name,
			unnamed: name === "(no value)",
			value: step.value,
			ofFirst: first > 0 ? step.value / first : 0,
			ofPrev: prev !== undefined && prev.value > 0 ? step.value / prev.value : null,
			dropped: prev !== undefined ? Math.max(0, prev.value - step.value) : 0,
			leavers: [],
			groups: groups.map((group) => ({
				name: group,
				color: colors.get(group) ?? "",
				value: step.byGroup.get(group) ?? 0,
				prev: prev?.byGroup.get(group) ?? step.byGroup.get(group) ?? 0,
			})),
		}
	})
	return { steps, legend: groups.map((name) => ({ name, color: colors.get(name) ?? "" })) }
}

export type DropoffSteps = Readonly<{
	steps: ReadonlyArray<Step>
	legend: ReadonlyArray<{ readonly name: string; readonly color: string }>
}>

/** `toSteps`: grouped or plain. */
export const toSteps = (source: ReadonlyArray<Row>, valueField: string): DropoffSteps => {
	const grouped = source.filter((row) => typeof row.group === "string")
	if (grouped.length > 0 && grouped.length === source.length) return groupedSteps(grouped, valueField)
	const rows = toBreakdownRows(source, valueField)
	const first = rows[0]?.value ?? 0
	return {
		legend: [],
		steps: rows.map((row, index): Step => {
			const raw = source[index] ?? {}
			const prev = rows[index - 1]
			return {
				...row,
				ofFirst: first > 0 ? row.value / first : 0,
				ofPrev: prev !== undefined && prev.value > 0 ? row.value / prev.value : null,
				dropped: prev !== undefined ? Math.max(0, prev.value - row.value) : 0,
				p50Ms: optionalNumber(raw.p50Ms),
				p90Ms: optionalNumber(raw.p90Ms),
				leavers: toLeavers(raw.leavers),
				groups: [],
			}
		}),
	}
}

/** `leaverRows`: the top leavers as shares of everyone who dropped, the remainder as "Other". */
export const leaverRows = (leavers: ReadonlyArray<Leaver>, dropped: number) => {
	const shown = leavers.slice(0, LEAVERS_SHOWN)
	const named = shown.reduce((acc, entry) => acc + entry.count, 0)
	const rows = shown.map((entry) => ({
		name: entry.name === "" ? ENDED_LABEL : entry.name,
		ended: entry.name === "",
		share: Math.min(1, entry.count / dropped),
	}))
	const rest = dropped - named
	return rest > 0 && leavers.length > LEAVERS_SHOWN
		? [...rows, { name: "Other", ended: true, share: rest / dropped }]
		: rows
}

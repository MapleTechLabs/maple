import { Array as Arr, Number as Num, Option, Order, String as Str } from "effect"
import type { DataSourceColumn, DataSourceTable, ResourceScalar } from "@maple/domain/data-sources"
import { bucketStart, bucketsFor, toEpochMs, toIso } from "./time"
import type { ResolvedFilter, ResourceCell, ResourceFieldDef, ResourceRow } from "./types"
import type { ValidatedQuery } from "./validate"

const comparable = (field: ResourceFieldDef | undefined, value: ResourceCell | undefined): ResourceCell =>
	field?.type === "timestamp" ? toEpochMs(value) : (value ?? null)

const ordered = (actual: ResourceCell, expected: ResourceScalar, test: (a: number, b: number) => boolean) =>
	typeof actual === "number" && typeof expected === "number" && test(actual, expected)

const matchesOne = (actual: ResourceCell, filter: ResolvedFilter, expected: ResourceScalar): boolean => {
	switch (filter.op) {
		case "eq":
		case "in":
			return actual === expected
		case "neq":
			return actual !== expected
		case "contains":
			return (
				typeof actual === "string" &&
				Str.includes(Str.toLowerCase(String(expected)))(Str.toLowerCase(actual))
			)
		case "gt":
			return ordered(actual, expected, (a, b) => a > b)
		case "gte":
			return ordered(actual, expected, (a, b) => a >= b)
		case "lt":
			return ordered(actual, expected, (a, b) => a < b)
		case "lte":
			return ordered(actual, expected, (a, b) => a <= b)
	}
}

const fieldNamed = (query: ValidatedQuery, name: string) =>
	Option.getOrUndefined(Arr.findFirst(query.def.fields, (f) => f.name === name))

/** Applies the filters the API could not. */
export const matchesAll = (query: ValidatedQuery, row: ResourceRow): boolean =>
	Arr.every(query.clientFilters, (filter) => {
		const actual = comparable(fieldNamed(query, filter.field), row[filter.field])
		const values: ReadonlyArray<ResourceScalar> =
			typeof filter.value === "object" ? filter.value : [filter.value]
		return Arr.some(values, (value) => matchesOne(actual, filter, value))
	})

export const valueColumn = (query: ValidatedQuery): string =>
	query.measure === null || query.measure.field === null
		? "count"
		: `${query.measure.fn}_${query.measure.field.name}`

const measureOf = (query: ValidatedQuery, rows: ReadonlyArray<ResourceRow>): number | null => {
	const measure = query.measure
	const field = measure?.field ?? null
	if (measure === null || field === null) return rows.length
	const values = Arr.filter(
		Arr.map(rows, (row) => comparable(field, row[field.name])),
		(value) => value !== null && value !== undefined,
	)
	if (measure.fn === "count_distinct") return new Set(values).size
	const numbers = Arr.filter(values, (value): value is number => typeof value === "number")
	if (!Arr.isArrayNonEmpty(numbers)) return measure.fn === "sum" ? 0 : null
	switch (measure.fn) {
		case "sum":
			return Num.sumAll(numbers)
		case "avg":
			return Num.sumAll(numbers) / numbers.length
		case "min":
			return Arr.min(numbers, Num.Order)
		default:
			return Arr.max(numbers, Num.Order)
	}
}

const cell = (field: ResourceFieldDef, value: ResourceCell | undefined): ResourceCell => {
	if (value === undefined || value === null) return null
	if (field.type !== "timestamp") return value
	const ms = toEpochMs(value)
	return ms === null ? null : toIso(ms)
}

const scalarKey = (value: ResourceCell): string =>
	typeof value === "string"
		? `s:${value}`
		: typeof value === "number" || typeof value === "boolean"
			? `p:${value}`
			: "null"

const columnsOf = (query: ValidatedQuery): ReadonlyArray<DataSourceColumn> => [
	...(query.timeGroup === null ? [] : [{ name: "bucket", type: "timestamp" as const }]),
	...(query.groupField === null ? [] : [{ name: query.groupField.name, type: query.groupField.type }]),
	{ name: valueColumn(query), type: "number" },
]

interface Group {
	readonly bucket: number | null
	readonly value: ResourceCell
	readonly rows: Array<ResourceRow>
}

interface Output {
	readonly group: Group
	readonly row: Record<string, unknown>
}

/** Groups and measures fetched rows; time groups list every bucket so line charts have no gaps. */
export const aggregateRows = (
	query: ValidatedQuery,
	rows: ReadonlyArray<ResourceRow>,
	window: { readonly startMs: number; readonly endMs: number; readonly granularitySeconds: number },
	maxRows: number,
): DataSourceTable => {
	const time = query.timeGroup
	const field = query.groupField
	const groups = new Map<string, Group>()
	const add = (bucket: number | null, value: ResourceCell, row: ResourceRow | null) => {
		const key = `${bucket ?? ""}|${scalarKey(value)}`
		const group = groups.get(key) ?? { bucket, value, rows: [] }
		if (row !== null) group.rows.push(row)
		groups.set(key, group)
	}
	if (time !== null && field === null) {
		Arr.forEach(bucketsFor(window.startMs, window.endMs, window.granularitySeconds), (b) =>
			add(bucketStart(b.startMs, window.granularitySeconds), null, null),
		)
	}
	Arr.forEach(rows, (row) => {
		const ms = time === null ? null : toEpochMs(row[time.name])
		add(
			ms === null ? null : bucketStart(ms, window.granularitySeconds),
			field === null ? null : (row[field.name] ?? null),
			row,
		)
	})
	if (time === null && field === null && groups.size === 0) add(null, null, null)
	const name = valueColumn(query)
	const out = Arr.map(Arr.fromIterable(groups.values()), (group): Output => {
		const row: Record<string, unknown> = {}
		if (time !== null) row.bucket = group.bucket === null ? null : toIso(group.bucket)
		if (field !== null) row[field.name] = cell(field, group.value)
		row[name] = measureOf(query, group.rows)
		return { group, row }
	})
	const sorted =
		time !== null
			? Arr.sort(
					out,
					Order.mapInput(Num.Order, (entry: Output) => entry.group.bucket ?? 0),
				)
			: Arr.sort(
					out,
					Order.combine(
						Order.mapInput(Order.flip(Num.Order), (entry: Output) =>
							Number(entry.row[name] ?? 0),
						),
						Order.mapInput(Order.String, (entry: Output) => scalarKey(entry.group.value)),
					),
				)
	return {
		columns: columnsOf(query),
		rows: Arr.map(Arr.take(sorted, maxRows), (entry) => entry.row),
		truncated: sorted.length > maxRows,
	}
}

/** List mode: the selected fields, timestamps as ISO strings. */
export const projectRows = (
	query: ValidatedQuery,
	rows: ReadonlyArray<ResourceRow>,
	truncated: boolean,
): DataSourceTable => ({
	columns: Arr.map(query.select, (f) => ({ name: f.name, type: f.type })),
	rows: Arr.map(Arr.take(rows, query.limit), (row) => {
		const out: Record<string, unknown> = {}
		Arr.forEach(query.select, (f) => {
			out[f.name] = cell(f, row[f.name])
		})
		return out
	}),
	truncated: truncated || rows.length > query.limit,
})

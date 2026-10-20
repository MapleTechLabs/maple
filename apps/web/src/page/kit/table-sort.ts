import { Schema } from "effect"

// The click-to-sort state as Model data, and the comparator.

export const SortDir = Schema.Literals(["asc", "desc"])
export type SortDir = typeof SortDir.Type

/** `useSortState`: the sorted column (`null` = source order) and its direction. */
export const SortState = Schema.Struct({ key: Schema.NullOr(Schema.String), dir: SortDir })
export type SortState = typeof SortState.Type

/** `SortState` over a table's own key schema. */
export const sortStateOf = <K extends Schema.Top>(key: K) =>
	Schema.Struct({ key: Schema.NullOr(key), dir: SortDir })
export type Sort<K = string> = Readonly<{ key: K | null; dir: SortDir }>

/** A sortable cell value. */
export type SortValue = number | string

/** `handleSort`: same key flips the direction (desc, asc, then source order when resettable); a new key starts asc for names, desc otherwise. */
export const nextSort = <K>(
	sort: Sort<K>,
	key: K,
	options: Readonly<{ stringKeys?: ReadonlyArray<K>; resettable?: boolean }> = {},
): Sort<K> => {
	if (key === sort.key) {
		if (sort.dir === "asc" && options.resettable === true) return { key: null, dir: sort.dir }
		return { key, dir: sort.dir === "asc" ? "desc" : "asc" }
	}
	return { key, dir: options.stringKeys?.includes(key) === true ? "asc" : "desc" }
}

const isNumericString = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))

/** `compareValues`: numeric when both sides are numbers (or numeric strings), else text. */
export const compareValues = (a: unknown, b: unknown, dir: SortDir): number => {
	const numeric =
		(typeof a === "number" && typeof b === "number") || (isNumericString(a) && isNumericString(b))
	if (numeric) {
		const an = Number(a)
		const bn = Number(b)
		const cmp = an < bn ? -1 : an > bn ? 1 : 0
		return dir === "asc" ? cmp : -cmp
	}
	const as = String(a)
	const bs = String(b)
	return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as)
}

/** `useTableSort`'s `sorted`: a stable sort by the active column, source order without one. */
export const sortRows = <Row>(
	rows: ReadonlyArray<Row>,
	sort: Sort,
	read: (row: Row, key: string) => SortValue,
): ReadonlyArray<Row> => {
	const key = sort.key
	return key === null ? rows : rows.toSorted((a, b) => compareValues(read(a, key), read(b, key), sort.dir))
}

/** `sortRows` on the row field named by the key, `pinned` rows first. */
export const sortRowsByField = <Row, K extends keyof Row>(
	rows: ReadonlyArray<Row>,
	sort: Sort<K>,
	pinned?: (row: Row) => boolean,
): ReadonlyArray<Row> => {
	const key = sort.key
	if (key === null) return rows
	const compare = (a: Row, b: Row) => compareValues(a[key], b[key], sort.dir)
	if (pinned === undefined) return rows.toSorted(compare)
	return [...rows.filter(pinned).toSorted(compare), ...rows.filter((row) => !pinned(row)).toSorted(compare)]
}

export type SortAccessors<Row> = ReadonlyMap<string, (row: Row) => SortValue>

/** `sortRows` through a table's column accessors; a key without one keeps source order. */
export const sortRowsBy = <Row>(
	rows: ReadonlyArray<Row>,
	sort: SortState,
	accessors: SortAccessors<Row>,
): ReadonlyArray<Row> => {
	const read = sort.key === null ? undefined : accessors.get(sort.key)
	return read === undefined ? rows : sortRows(rows, sort, (row) => read(row))
}

import { Schema } from "effect"

// `useSortState` / `useTableSort` (apps/web/src/hooks/use-table-sort.ts, a React module): the
// click-to-sort state as Model data, and the comparator copied verbatim.

export const SortDir = Schema.Literals(["asc", "desc"])
export type SortDir = typeof SortDir.Type

/** `useSortState`: the sorted column (`null` = source order) and its direction. */
export const SortState = Schema.Struct({ key: Schema.NullOr(Schema.String), dir: SortDir })
export type SortState = typeof SortState.Type

/** A sortable cell value. */
export type SortValue = number | string

/** `handleSort`: same key flips the direction, a new key starts asc for names, desc otherwise. */
export const nextSort = (
	state: SortState,
	key: string,
	stringKeys: ReadonlyArray<string>,
	isResettable = false,
): SortState => {
	if (key !== state.key) return { key, dir: stringKeys.includes(key) ? "asc" : "desc" }
	// desc → asc → (resettable) source order
	if (state.dir === "asc" && isResettable) return { key: null, dir: state.dir }
	return { key, dir: state.dir === "asc" ? "desc" : "asc" }
}

const isNumericString = (value: SortValue): value is string =>
	typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))

/** `compareValues`: numeric when both sides are numbers (or numeric strings), else text. */
export const compareValues = (av: SortValue, bv: SortValue, dir: SortDir): number => {
	const numeric =
		(typeof av === "number" && typeof bv === "number") || (isNumericString(av) && isNumericString(bv))
	if (numeric) {
		const an = Number(av)
		const bn = Number(bv)
		const cmp = an < bn ? -1 : an > bn ? 1 : 0
		return dir === "asc" ? cmp : -cmp
	}
	const as = String(av)
	const bs = String(bv)
	return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as)
}

/** `useTableSort`'s `sorted`: a stable sort by the active column, source order without one. */
export const sortRows = <Row>(
	rows: ReadonlyArray<Row>,
	sort: SortState,
	read: (row: Row, key: string) => SortValue,
): ReadonlyArray<Row> => {
	const key = sort.key
	return key === null ? rows : rows.toSorted((a, b) => compareValues(read(a, key), read(b, key), sort.dir))
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

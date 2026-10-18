import { Schema } from "effect"
import type { SortDir } from "./data-table"

// `useSortState` / `useTableSort` (apps/web/src/hooks/use-table-sort.ts, a React module): the
// click-to-sort state as Model data, and the comparator copied verbatim.

export const SortState = Schema.Struct({
	key: Schema.NullOr(Schema.String),
	dir: Schema.Literals(["asc", "desc"]),
})
export type SortState = typeof SortState.Type

/** `handleSort`: same key flips the direction, a new key starts asc for names, desc otherwise. */
export const nextSort = (state: SortState, key: string, stringKeys: ReadonlyArray<string>): SortState =>
	key === state.key
		? { key, dir: state.dir === "asc" ? "desc" : "asc" }
		: { key, dir: stringKeys.includes(key) ? "asc" : "desc" }

const isNumericString = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))

// copied: `compareValues` (use-table-sort.ts).
const compareValues = (av: unknown, bv: unknown, dir: SortDir): number => {
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

export type SortAccessors<Row> = ReadonlyMap<string, (row: Row) => string | number>

/** `useTableSort`'s `sorted`: `row[sortKey]` through the table's column accessors; source order without a key. */
export const sortRows = <Row>(
	rows: ReadonlyArray<Row>,
	state: SortState,
	accessors: SortAccessors<Row>,
): ReadonlyArray<Row> => {
	const read = state.key === null ? undefined : accessors.get(state.key)
	if (read === undefined) return rows
	return [...rows].sort((a, b) => compareValues(read(a), read(b), state.dir))
}

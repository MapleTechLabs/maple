import { Schema } from "effect"

// `useSortState` / `useTableSort` (apps/web/src/hooks/use-table-sort.ts) as Model state and pure functions.

export const SortDir = Schema.Literals(["asc", "desc"])
export type SortDir = typeof SortDir.Type

export const SortState = <K extends Schema.Top>(key: K) =>
	Schema.Struct({ key: Schema.NullOr(key), dir: SortDir })

export type Sort<K> = Readonly<{ key: K | null; dir: SortDir }>

/** A click on column `key`: flip the active one (or clear it when resettable), else start it. */
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

/** `useTableSort`'s `sorted`: a stable sort on one field, `pinned` rows first. */
export const sortRows = <Row, K extends keyof Row>(
	rows: ReadonlyArray<Row>,
	sort: Sort<K>,
	pinned?: (row: Row) => boolean,
): ReadonlyArray<Row> => {
	const key = sort.key
	if (key === null) return rows
	const compare = (a: Row, b: Row) => compareValues(a[key], b[key], sort.dir)
	if (pinned === undefined) return [...rows].sort(compare)
	return [...rows.filter(pinned).sort(compare), ...rows.filter((row) => !pinned(row)).sort(compare)]
}

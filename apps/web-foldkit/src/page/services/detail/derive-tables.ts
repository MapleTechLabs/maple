import type { SortDir, SortState, SortTable } from "./model-tabs"

// `useSortState` / `useTableSort` (apps/web/src/hooks/use-table-sort.ts) and the drill-down searches.

/** A table's first sorted column and the text columns that start ascending. */
const sortConfig = (initialKey: string, stringKeys: ReadonlyArray<string> = []) => ({
	initialKey,
	stringKeys,
})

const SORT_CONFIG = {
	operations: sortConfig("estimatedSpanCount"),
	endpoints: sortConfig("traffic", ["path"]),
	dependencies: sortConfig("callsPerSec"),
} satisfies Record<SortTable, ReturnType<typeof sortConfig>>

export const initialSort = (table: SortTable): SortState => ({
	key: SORT_CONFIG[table].initialKey,
	dir: "desc",
})

/** `handleSort`: the active column flips direction; another column starts desc (asc for text). */
export const nextSort = (table: SortTable, current: SortState, key: string): SortState =>
	key === current.key
		? { key, dir: current.dir === "asc" ? "desc" : "asc" }
		: { key, dir: SORT_CONFIG[table].stringKeys.includes(key) ? "asc" : "desc" }

/** A sortable cell value. */
export type SortValue = number | string

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

/** `operationTraceSearch`: the /traces search for one operation, at span level. */
export const operationTraceSearch = (args: {
	readonly serviceName: string
	readonly spanName: string
	readonly environments?: ReadonlyArray<string> | undefined
	readonly startTime?: string | undefined
	readonly endTime?: string | undefined
	readonly timePreset?: string | undefined
}) => ({
	services: [args.serviceName],
	spanNames: [args.spanName],
	deploymentEnvs: args.environments?.length ? [...args.environments] : undefined,
	rootOnly: false,
	startTime: args.startTime,
	endTime: args.endTime,
	timePreset: args.timePreset,
})

/** Trace drill-downs cover the latest 30 days: past that the window is clamped to its last 30 days. */
export const TRACE_DETAIL_LIMIT_SECONDS = 30 * 24 * 60 * 60

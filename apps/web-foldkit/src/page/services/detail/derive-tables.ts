import { nextSort as nextSortBy, type SortState } from "../../kit/table-sort"
import type { SortTable } from "./model-tabs"

// The tabs' sort configuration (`useSortState` per table) and the drill-down searches.

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
	nextSortBy(current, key, { stringKeys: SORT_CONFIG[table].stringKeys })

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

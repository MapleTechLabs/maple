import type { V2PlanetScaleDatabase } from "@maple/domain/http/v2"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { badge } from "../../../../ui/display"
import { skeleton } from "../../../../ui/skeleton"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	skeletonRows,
	ROW_LINK_CLASS,
} from "../../../infra/kit/data-table"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import type { DatabaseStat } from "../data"
import {
	abnormalState,
	formatLag,
	formatStoragePercent,
	lagClass,
	MISSING,
	utilizationClass,
} from "../../../../components/infra/planetscale/metrics"
import { formatWholePercent } from "../../../../components/infra/format"
import { Message, type SortKey } from "./model"

// `PlanetScaleDatabaseTable` and its loading state.

type H = HtmlBuilder<Message>

interface DatabaseRow {
	readonly id: string
	readonly name: string
	readonly kind: string
	readonly region: string | null
	readonly plan: string | null
	readonly state: string | null
	readonly branchCount: number
	readonly hasStats: boolean
	readonly connectionsAvg: number
	readonly cpuMaxPercent: number
	readonly memMaxPercent: number
	readonly storageUsedPercent: number
	readonly replicaLagMaxSeconds: number
}

const COLUMNS: ReadonlyArray<{
	label: string
	key: SortKey
	width: string
	align?: "right"
	hidden?: string
	metric?: boolean
}> = [
	{ label: "Database", key: "name", width: "w-0 flex-1 min-w-[220px]" },
	{ label: "Branches", key: "branchCount", width: "w-[80px]", align: "right", hidden: "hidden md:flex" },
	{ label: "Connections", key: "connectionsAvg", width: "w-[96px]", align: "right", metric: true },
	{ label: "CPU (max)", key: "cpuMaxPercent", width: "w-[88px]", align: "right", metric: true },
	{
		label: "Memory (max)",
		key: "memMaxPercent",
		width: "w-[104px]",
		align: "right",
		hidden: "hidden md:flex",
		metric: true,
	},
	{ label: "Storage", key: "storageUsedPercent", width: "w-[80px]", align: "right", metric: true },
	{ label: "Replica lag", key: "replicaLagMaxSeconds", width: "w-[88px]", align: "right", metric: true },
]

/** `headerCells`: sortable heads only when a sort is given; `metricsPaused` drops the metric columns. */
const headerCells = (h: H, sort: Sort<SortKey> | undefined, metricsPaused: boolean): ReadonlyArray<Html> =>
	COLUMNS.filter((column) => !metricsPaused || column.metric !== true).map((column) =>
		columnHead(h, {
			label: column.label,
			width: column.width,
			align: column.align,
			hidden: column.hidden,
			sort:
				sort === undefined
					? undefined
					: {
							onSort: Message.ClickedSort({ key: column.key }),
							isActive: sort.key === column.key,
							dir: sort.dir,
						},
		}),
	)

export const databaseTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Databases" },
		headerCells(h, undefined, false),
		skeletonRows(h, 3, () => [
			h.div([h.Class("w-0 min-w-[220px] flex-1")], [skeleton(h, "h-4 w-44")]),
			skeleton(h, "hidden h-3 w-[80px] md:block"),
			skeleton(h, "h-3 w-[96px]"),
			skeleton(h, "h-3 w-[88px]"),
			skeleton(h, "hidden h-3 w-[104px] md:block"),
			skeleton(h, "h-3 w-[80px]"),
			skeleton(h, "h-3 w-[88px]"),
		]),
	)

const toRow = (db: V2PlanetScaleDatabase, statsByName: ReadonlyMap<string, DatabaseStat>): DatabaseRow => {
	const stats = statsByName.get(db.name.toLowerCase())
	return {
		id: db.id,
		name: db.name,
		kind: db.kind,
		region: db.region,
		plan: db.plan,
		state: db.state,
		branchCount: db.branches.length,
		hasStats: stats !== undefined,
		connectionsAvg: stats?.connectionsAvg ?? MISSING,
		cpuMaxPercent: stats?.cpuMaxPercent ?? MISSING,
		memMaxPercent: stats?.memMaxPercent ?? MISSING,
		storageUsedPercent: stats?.storageUsedPercent ?? MISSING,
		replicaLagMaxSeconds: stats?.replicaLagMaxSeconds ?? MISSING,
	}
}

const CELL = "text-right font-mono text-xs tabular-nums text-foreground/80"

const metaChip = (h: H, text: string): Html =>
	h.span(
		[h.Class("hidden shrink-0 xl:inline-flex")],
		[h.span([h.Class("font-mono text-3xs text-muted-foreground/80")], [text])],
	)

const metricCells = (h: H, row: DatabaseRow): ReadonlyArray<Html> => [
	h.div([h.Class(cn("w-[96px]", CELL))], [row.hasStats ? formatNumber(row.connectionsAvg) : EMPTY_VALUE]),
	h.div(
		[h.Class(cn("w-[88px]", CELL, row.hasStats && utilizationClass(row.cpuMaxPercent)))],
		[row.hasStats ? formatWholePercent(row.cpuMaxPercent / 100) : EMPTY_VALUE],
	),
	h.div(
		[
			h.Class(
				cn("hidden w-[104px]", CELL, "md:block", row.hasStats && utilizationClass(row.memMaxPercent)),
			),
		],
		[row.hasStats ? formatWholePercent(row.memMaxPercent / 100) : EMPTY_VALUE],
	),
	h.div(
		[
			h.Class(
				cn(
					"w-[80px]",
					CELL,
					row.storageUsedPercent !== MISSING && utilizationClass(row.storageUsedPercent),
				),
			),
		],
		[row.storageUsedPercent === MISSING ? EMPTY_VALUE : formatStoragePercent(row.storageUsedPercent)],
	),
	h.div(
		[h.Class(cn("w-[88px]", CELL, row.hasStats && lagClass(row.replicaLagMaxSeconds)))],
		[row.hasStats ? formatLag(row.replicaLagMaxSeconds) : EMPTY_VALUE],
	),
]

const databaseRow = (h: H, row: DatabaseRow, metricsPaused: boolean): Html => {
	const state = abnormalState(row.state)
	return h.a(
		[
			h.Class(ROW_LINK_CLASS),
			h.Href(hrefOf(AppRoute.InfraPlanetscaleDatabase({ dbName: row.name, search: {} }))),
		],
		[
			h.div(
				[h.Class("flex w-0 min-w-[220px] flex-1 items-center gap-2 overflow-hidden")],
				[
					h.span(
						[
							h.Class(
								"min-w-0 truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							),
							h.Title(row.name),
						],
						[row.name],
					),
					badge(h, { variant: "outline", className: "shrink-0" }, [
						row.kind === "postgresql" ? "Postgres" : "MySQL",
					]),
					...(state === null
						? []
						: [badge(h, { variant: "warn", className: "shrink-0" }, [state])]),
					...(row.region ? [metaChip(h, row.region)] : []),
					...(row.plan ? [metaChip(h, row.plan)] : []),
				],
			),
			h.div([h.Class(cn("hidden w-[80px]", CELL, "md:block"))], [String(row.branchCount)]),
			...(metricsPaused ? [] : metricCells(h, row)),
		],
	)
}

export type DatabaseTableInputs = Readonly<{
	databases: ReadonlyArray<V2PlanetScaleDatabase>
	stats: ReadonlyArray<DatabaseStat>
	sort: Sort<SortKey>
	isWaiting: boolean
	metricsPaused: boolean
	emptyMessage: string
}>

export const databaseTable = (h: H, inputs: DatabaseTableInputs): Html => {
	const statsByName = new Map(inputs.stats.map((row) => [row.database.toLowerCase(), row]))
	const rows = sortRowsByField(
		inputs.databases.map((db) => toRow(db, statsByName)),
		inputs.sort,
	)
	return dataTable(
		h,
		{ ariaLabel: "PlanetScale databases", isWaiting: inputs.isWaiting },
		headerCells(h, inputs.sort, inputs.metricsPaused),
		rows.length === 0
			? [dataTableEmpty(h, [inputs.emptyMessage])]
			: rows.map((row) => databaseRow(h, row, inputs.metricsPaused)),
	)
}

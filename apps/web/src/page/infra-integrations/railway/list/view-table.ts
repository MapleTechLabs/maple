import type { RailwayEnvironmentStatus } from "@maple/domain/http"
import { formatBytes, pluralize } from "@maple/ui/lib/format"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { skeleton } from "../../../../ui/skeleton"
import { columnHead, dataTable, skeletonRows, ROW_LINK_CLASS } from "../../../infra/kit/data-table"
import { meterRows } from "../../../infra/kit/meter-rows"
import { avgPeak } from "../../../infra/kit/avg-peak"
import { relativeTime } from "../../../kit/relative-time"
import type { Sort } from "../../../kit/table-sort"
import type { RailwayServiceRow } from "../model"
import { formatVcpu, groupedRows, type RailwayRowView, type RailwaySync, rowKey } from "./derive"
import { Message } from "./message"
import type { SortKey } from "./model"

// `RailwayServiceTable` and `RailwayServiceTableLoading`.

type H = HtmlBuilder<Message>
type Trigger = (id: string) => ReadonlyArray<ChildAttribute>

export type Clock = Readonly<{ nowMs: number; timeZone: string }>

const COLUMNS: ReadonlyArray<{
	label: string
	key: SortKey
	width: string
	align?: "right"
	hidden?: string
	limitsOnly?: boolean
}> = [
	{ label: "Service", key: "displayName", width: "w-0 flex-1 min-w-[240px]" },
	{ label: "Memory", key: "memoryMax", width: "w-[150px]", align: "right" },
	{ label: "vCPU", key: "cpuMax", width: "w-[140px]", align: "right" },
	{ label: "Of limit", key: "peakOfLimit", width: "w-[160px]", hidden: "hidden lg:flex", limitsOnly: true },
	{ label: "Replicas", key: "replicas", width: "w-[80px]", align: "right" },
	{ label: "Last seen", key: "lastSeen", width: "w-[100px]", align: "right" },
]

const columns = (h: H, showLimits: boolean, sort: Sort<SortKey> | undefined): ReadonlyArray<Html> =>
	COLUMNS.filter((column) => showLimits || column.limitsOnly !== true).map((column) =>
		columnHead(h, {
			label: column.label,
			width: column.width,
			align: column.align,
			hidden: column.hidden,
			sort:
				sort === undefined
					? { isActive: false, dir: "desc" }
					: {
							onSort: Message.ClickedSort({ key: column.key }),
							isActive: sort.key === column.key,
							dir: sort.dir,
						},
		}),
	)

export const railwayTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Railway services" },
		columns(h, false, undefined),
		skeletonRows(h, 5, () => [
			h.div([h.Class("w-0 min-w-[240px] flex-1")], [skeleton(h, "h-4 w-36")]),
			skeleton(h, "ml-auto h-3 w-[150px]"),
			skeleton(h, "ml-auto h-3 w-[140px]"),
			skeleton(h, "ml-auto h-3 w-[80px]"),
			skeleton(h, "h-3 w-[100px]"),
		]),
	)

const syncNote = (h: H, sync: RailwaySync, clock: Clock): Html => {
	switch (sync.kind) {
		case "synced":
			return relativeTime(h, { tooltip: "title", value: sync.at, ...clock, prefix: "synced" })
		case "pending":
			return h.span([], ["waiting on the first sync"])
		case "unknown":
			return h.span([], ["no longer polled"])
		case "paused":
			return h.span(
				[h.Class("text-severity-error")],
				[
					"paused",
					...(sync.lastSyncedAt !== null
						? [
								" · last data ",
								relativeTime(h, { tooltip: "title", value: sync.lastSyncedAt, ...clock }),
							]
						: []),
				],
			)
		case "failing":
			return h.span(
				[h.Class("truncate text-severity-error"), h.Title(sync.error)],
				["sync failing: ", sync.error],
			)
	}
}

/** Tooltip trigger ids: one per cell with a `Tooltip`. */
export const triggerIds = (row: RailwayServiceRow) => {
	const key = rowKey(row)
	return { memory: `railway-mem-${key}`, cpu: `railway-cpu-${key}`, seen: `railway-seen-${key}` }
}

const NOTE = "Summed across replicas."

const row = (h: H, view: RailwayRowView, showLimits: boolean, clock: Clock, trigger: Trigger): Html => {
	const ids = triggerIds(view)
	return h.a(
		[
			h.Class(ROW_LINK_CLASS),
			h.Href(
				hrefOf(
					AppRoute.InfraRailwayService({
						serviceId: view.serviceId,
						search: { environmentId: view.environmentId },
					}),
				),
			),
		],
		[
			h.div(
				[h.Class("w-0 min-w-[240px] flex-1")],
				[
					h.div(
						[
							h.Class(
								"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							),
							h.Title(view.displayName),
						],
						[view.displayName],
					),
				],
			),
			h.div(
				[h.Class("w-[150px] text-right")],
				[
					avgPeak(
						h,
						{ avg: view.memoryAvg, peak: view.memoryMax, format: formatBytes, note: NOTE },
						trigger(ids.memory),
					),
				],
			),
			h.div(
				[h.Class("w-[140px] text-right")],
				[
					avgPeak(
						h,
						{ avg: view.cpuAvg, peak: view.cpuMax, format: formatVcpu, note: NOTE },
						trigger(ids.cpu),
					),
				],
			),
			...(showLimits
				? [
						h.div(
							[h.Class("hidden w-[160px] lg:block")],
							[
								meterRows(h, [
									{ label: "CPU", fraction: view.cpuOfLimit },
									{ label: "MEM", fraction: view.memoryOfLimit },
								]),
							],
						),
					]
				: []),
			h.div(
				[h.Class("w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80")],
				[String(view.replicas)],
			),
			h.div(
				[h.Class("w-[100px] text-right")],
				[
					relativeTime(h, {
						value: view.lastSeen,
						...clock,
						mono: true,
						className: "cursor-default text-2xs text-muted-foreground",
						trigger: trigger(ids.seen),
					}),
				],
			),
		],
	)
}

export type RailwayTableInputs = Readonly<{
	services: ReadonlyArray<RailwayServiceRow>
	environments: ReadonlyArray<RailwayEnvironmentStatus>
	authFailed: boolean
	showLimits: boolean
	sort: Sort<SortKey>
	clock: Clock
	trigger: Trigger
}>

export const railwayTable = (h: H, inputs: RailwayTableInputs): Html =>
	dataTable(
		h,
		{ ariaLabel: "Railway services" },
		columns(h, inputs.showLimits, inputs.sort),
		groupedRows(inputs.services, inputs.environments, inputs.authFailed, inputs.sort).flatMap((group) => [
			h.div(
				[
					h.Class(
						"flex items-center gap-2.5 border-b border-border/60 bg-muted/30 px-4 py-2 font-mono text-2xs",
					),
				],
				[
					h.span([h.Class("font-medium text-foreground")], [group.projectName]),
					h.span([h.Class("text-muted-foreground")], ["/ ", group.environmentName]),
					h.span(
						[h.Class("ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground")],
						[
							h.span(
								[h.Class("shrink-0")],
								[
									String(group.services.length),
									" ",
									pluralize(group.services.length, "service"),
									" ·",
									" ",
									formatBytes(group.memoryAvg),
									" ·",
								],
							),
							syncNote(h, group.sync, inputs.clock),
						],
					),
				],
			),
			...group.services.map((view) => row(h, view, inputs.showLimits, inputs.clock, inputs.trigger)),
		]),
	)

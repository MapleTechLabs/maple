import { formatBytes } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { badge } from "../../../../ui/display"
import { skeleton } from "../../../../ui/skeleton"
import { projectStatusLabel } from "../../../integrations/supabase"
import { columnHead, dataTable, ROW_LINK_CLASS, skeletonRows } from "../../../infra/kit/data-table"
import { meterRows } from "../../../infra/kit/meter-rows"
import { relativeTime } from "../../../kit/relative-time"
import type { Sort } from "../../../kit/table-sort"
import { type ProjectView, sortProjects } from "./derive"
import { Message } from "./message"
import type { SortKey } from "./model"

// The project table and its loading state.

type H = HtmlBuilder<Message>

export type Clock = Readonly<{ nowMs: number; timeZone: string }>

const COLUMNS: ReadonlyArray<{
	label: string
	key: SortKey | null
	width: string
	align?: "right"
	hidden?: string
}> = [
	{ label: "Project", key: "displayName", width: "w-0 flex-1 min-w-[220px]" },
	{ label: "Region", key: null, width: "w-[120px]", hidden: "hidden md:flex" },
	{ label: "Peak use", key: "peak", width: "w-[180px]" },
	{ label: "DB size", key: "dbSize", width: "w-[100px]", align: "right" },
	{ label: "Connections", key: "connectionsMax", width: "w-[110px]", align: "right" },
	{ label: "Last seen", key: "lastSeen", width: "w-[100px]", align: "right" },
]

const columns = (h: H, sort: Sort<SortKey> | undefined): ReadonlyArray<Html> =>
	COLUMNS.map((column) =>
		columnHead(h, {
			label: column.label,
			width: column.width,
			align: column.align,
			hidden: column.hidden,
			sort:
				sort === undefined || column.key === null
					? undefined
					: {
							onSort: Message.ClickedSort({ key: column.key }),
							isActive: sort.key === column.key,
							dir: sort.dir,
						},
		}),
	)

export const supabaseTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Supabase projects" },
		columns(h, undefined),
		skeletonRows(h, 4, () => [
			h.div([h.Class("w-0 min-w-[220px] flex-1")], [skeleton(h, "h-4 w-36")]),
			skeleton(h, "hidden h-3 w-[120px] md:block"),
			skeleton(h, "h-3 w-[180px]"),
			skeleton(h, "ml-auto h-3 w-[100px]"),
			skeleton(h, "ml-auto h-3 w-[110px]"),
			skeleton(h, "h-3 w-[100px]"),
		]),
	)

const MUTED_CELL = "text-2xs text-muted-foreground"

/** A project without metrics in the window says why instead of showing zeros. */
const usageCell = (h: H, view: ProjectView): Html => {
	if (view.metrics !== null)
		return meterRows(h, [
			{ label: "CPU", fraction: view.metrics.cpuMax },
			{ label: "MEM", fraction: view.metrics.memoryMax },
			{ label: "DISK", fraction: view.metrics.diskUsedMax },
		])
	return h.span(
		[h.Class(MUTED_CELL)],
		[view.collection === "waiting" ? "Waiting for the first scrape" : "Not collected"],
	)
}

const numberCell = (h: H, text: string | null): Html =>
	h.span(
		[h.Class(text === null ? MUTED_CELL : "font-mono text-xs tabular-nums text-foreground/80")],
		[text ?? "-"],
	)

const row = (h: H, view: ProjectView, clock: Clock): Html => {
	const pill = view.status === null ? null : projectStatusLabel(view.status)
	return h.a(
		[
			h.Key(view.ref),
			h.Class(ROW_LINK_CLASS),
			h.Href(hrefOf(AppRoute.InfraSupabaseProject({ projectRef: view.ref, search: {} }))),
		],
		[
			h.div(
				[h.Class("flex w-0 min-w-[220px] flex-1 flex-col gap-0.5")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							h.span(
								[
									h.Class(
										"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
									),
									h.Title(view.displayName),
								],
								[view.displayName],
							),
							...(pill === null
								? []
								: [badge(h, { variant: pill.tone, className: "shrink-0" }, [pill.label])]),
						],
					),
					h.span([h.Class("font-mono text-2xs text-muted-foreground")], [view.ref]),
				],
			),
			h.div(
				[h.Class("hidden w-[120px] truncate text-xs text-muted-foreground md:block")],
				[view.region || "-"],
			),
			h.div([h.Class("w-[180px]")], [usageCell(h, view)]),
			h.div(
				[h.Class("w-[100px] text-right")],
				[numberCell(h, view.metrics === null ? null : formatBytes(view.metrics.dbSize))],
			),
			h.div(
				[h.Class("w-[110px] text-right")],
				[
					numberCell(
						h,
						view.metrics === null ? null : String(Math.round(view.metrics.connectionsMax)),
					),
				],
			),
			h.div(
				[h.Class("w-[100px] text-right")],
				[
					view.metrics === null
						? numberCell(h, null)
						: relativeTime(h, {
								value: view.metrics.lastSeen,
								...clock,
								mono: true,
								tooltip: "title",
								className: "text-2xs text-muted-foreground",
							}),
				],
			),
		],
	)
}

export type SupabaseTableInputs = Readonly<{
	projects: ReadonlyArray<ProjectView>
	sort: Sort<SortKey>
	clock: Clock
}>

export const supabaseTable = (h: H, inputs: SupabaseTableInputs): Html =>
	dataTable(
		h,
		{ ariaLabel: "Supabase projects" },
		columns(h, inputs.sort),
		sortProjects(inputs.projects, inputs.sort).map((view) => row(h, view, inputs.clock)),
	)

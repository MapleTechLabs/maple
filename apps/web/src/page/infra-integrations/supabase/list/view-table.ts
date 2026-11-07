import { EMPTY_VALUE, formatPercent, formatRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { meter } from "@maple/views/ui/meter"
import { skeleton } from "@maple/views/ui/skeleton"
import { columnHead, dataTable, ROW_LINK_CLASS, skeletonRows } from "../../../infra/kit/data-table"
import { collectingLabel, healthPill, SATURATION } from "../health"
import type { ProjectView } from "./derive"
import type { Message } from "./message"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { hstack, vstack } from "@maple/views/ui/stack"

// The project table and its loading state.

type H = HtmlBuilder<Message>

const COLUMNS: ReadonlyArray<{ label: string; width: string; align?: "right"; hidden?: string }> = [
	{ label: "Project", width: "w-0 flex-1 min-w-40" },
	{ label: "Status", width: "w-20" },
	{ label: "CPU", width: "w-24", hidden: "hidden lg:flex" },
	{ label: "Memory", width: "w-24", hidden: "hidden lg:flex" },
	{ label: "Disk", width: "w-24", hidden: "hidden lg:flex" },
	{ label: "Connections", width: "w-20", align: "right" },
	{ label: "Req / min", width: "w-16", align: "right", hidden: "hidden md:flex" },
	{ label: "Issues", width: "w-14", align: "right", hidden: "hidden md:flex" },
	{ label: "Collecting", width: "w-28", align: "right" },
]

const columns = (h: H): ReadonlyArray<Html> =>
	Arr.map(COLUMNS, (column) =>
		columnHead(h, {
			label: column.label,
			width: column.width,
			align: column.align,
			hidden: column.hidden,
		}),
	)

export const supabaseTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Supabase projects" },
		columns(h),
		skeletonRows(h, 4, () => [
			h.div(
				[h.Class("w-0 min-w-40 flex-1 space-y-1.5")],
				[skeleton(h, "h-3.5 w-36"), skeleton(h, "h-2.5 w-48")],
			),
			skeleton(h, "h-4 w-16"),
			skeleton(h, "hidden h-1.5 w-24 lg:block"),
			skeleton(h, "hidden h-1.5 w-24 lg:block"),
			skeleton(h, "hidden h-1.5 w-24 lg:block"),
			skeleton(h, "ml-auto h-3 w-16"),
			skeleton(h, "ml-auto hidden h-3 w-12 md:block"),
			skeleton(h, "ml-auto hidden h-3 w-10 md:block"),
			skeleton(h, "ml-auto h-3 w-24"),
		]),
	)

const MUTED = typographyClass({ size: "2xs", tone: "muted", mono: true })
const NUMBER = typographyClass({ size: "xs", tone: "soft", mono: true, numeric: true })

/** A utilisation bar and its percent; a project without metrics shows an empty track. */
const usageCell = (h: H, label: string, fraction: number | null): Html =>
	h.div(
		[h.Class("hidden w-24 items-center gap-2 lg:flex")],
		[
			meter(h, {
				value: fraction ?? 0,
				tone: fraction !== null && fraction >= SATURATION ? "warn" : "ok",
				className: "h-1 w-12 shrink-0",
				label: fraction === null ? undefined : `${label} ${formatPercent(fraction)}`,
			}),
			h.span(
				[
					h.Class(
						cn(
							"font-mono text-2xs tabular-nums",
							fraction === null ? "text-muted-foreground" : "text-foreground-soft",
						),
					),
				],
				[fraction === null ? EMPTY_VALUE : formatPercent(fraction)],
			),
		],
	)

const connectionsCell = (h: H, view: ProjectView): Html => {
	const metrics = view.metrics
	if (metrics === null) return h.span([h.Class(MUTED)], [EMPTY_VALUE])
	const peak = Math.round(metrics.connectionsMax)
	const limit = metrics.maxConnections
	const isNear = limit !== null && peak >= limit * SATURATION
	return h.span(
		[
			h.Class(cn(NUMBER, isNear && "text-severity-warn")),
			h.Title(
				limit === null ? "Peak Postgres connections" : "Peak Postgres connections of max_connections",
			),
		],
		[limit === null ? String(peak) : `${peak} / ${limit}`],
	)
}

const numberCell = (h: H, value: number | null, className: string): Html =>
	h.div(
		[h.Class(cn("justify-end", className))],
		[
			h.span(
				[h.Class(value === null ? MUTED : NUMBER)],
				[value === null ? EMPTY_VALUE : formatRate(value)],
			),
		],
	)

const collectingCell = (h: H, view: ProjectView): Html => {
	const isWaiting = view.collection === "waiting" && !view.logsEnabled
	return h.span(
		[
			h.Class(cn(MUTED, "truncate")),
			h.Title(isWaiting ? "Waiting for the first scrape" : collectingLabel(view)),
		],
		[isWaiting ? "Waiting" : collectingLabel(view)],
	)
}

const row = (h: H, view: ProjectView): Html => {
	const metrics = view.metrics
	const logs = (value: number) => (metrics === null || !view.logsEnabled ? null : value)
	return h.a(
		[
			h.Key(view.ref),
			h.Class(cn(ROW_LINK_CLASS, view.health._tag === "Paused" && "opacity-60")),
			h.Href(hrefOf(AppRoute.InfraSupabaseProject({ projectRef: view.ref, search: {} }))),
		],
		[
			vstack(h, { gap: "0.5", grow: true, className: "w-0 min-w-40" }, [
				typography(
					h,
					{
						size: "xs",
						tone: "foreground",
						weight: "medium",
						mono: true,
						truncate: true,
						className: "transition-colors group-hover:text-primary",
						attributes: [h.Title(view.displayName)],
					},
					[view.displayName],
				),
				typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true }, [
					view.region === "" ? view.ref : `${view.ref} · ${view.region}`,
				]),
			]),
			h.div([h.Class("w-20")], [healthPill(h, view.health)]),
			usageCell(h, "CPU", metrics?.cpuAvg ?? null),
			usageCell(h, "Memory", metrics?.memoryAvg ?? null),
			usageCell(h, "Disk", metrics?.diskUsedMax ?? null),
			hstack(h, { align: "stretch", justify: "end", className: "w-20" }, [connectionsCell(h, view)]),
			numberCell(h, logs(metrics?.requestsPerMinute ?? 0), "hidden w-16 md:flex"),
			numberCell(h, logs(metrics?.issueCount ?? 0), "hidden w-14 md:flex"),
			hstack(h, { align: "stretch", justify: "end", className: "w-28" }, [collectingCell(h, view)]),
		],
	)
}

export const supabaseTable = (h: H, projects: ReadonlyArray<ProjectView>, isWaiting: boolean): Html =>
	dataTable(
		h,
		{ ariaLabel: "Supabase projects", isWaiting },
		columns(h),
		Arr.map(projects, (view) => row(h, view)),
	)

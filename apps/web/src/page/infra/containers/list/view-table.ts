import { formatWholePercent } from "../../../../components/infra/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { middleTruncate } from "../../../../ui/middle-truncate"
import { skeleton } from "../../../../ui/skeleton"
import { avgPeak } from "../../kit/avg-peak"
import { columnHead, dataTable, dataTableEmpty, headSort, ROW_LINK_CLASS, skeletonRows } from "../../kit/data-table"
import type { SortDir } from "../../../kit/table-sort"
import { meterRows } from "../../kit/meter-rows"
import { metaLine } from "../../kit/meta-line"
import { relativeTime } from "../../../kit/relative-time"
import { hostStatusBadge } from "../../kit/status"
import { type ContainerSortKey, Message } from "./message"
import type { ContainerRow } from "./model"

// `ContainerTable` / `ContainerTableLoading`.

type H = HtmlBuilder<Message>
type Sort = Readonly<{ key: string | null; dir: SortDir }> | null

const head = (sort: Sort, key: ContainerSortKey) => headSort(sort, key, (k) => Message.ClickedSort({ key: k }))

const columns = (h: H, sort: Sort): ReadonlyArray<Html> => [
	columnHead(h, { label: "Container", sort: head(sort, "containerName"), width: "w-0 flex-1 min-w-[260px]" }),
	columnHead(h, { label: "Peak saturation", sort: head(sort, "saturation"), width: "w-44", hidden: "hidden md:flex" }),
	columnHead(h, { label: "CPU", sort: head(sort, "cpuPct"), align: "right", width: "w-32", hidden: "hidden lg:flex" }),
	columnHead(h, {
		label: "Mem of limit",
		sort: head(sort, "memoryPct"),
		align: "right",
		width: "w-32",
		hidden: "hidden lg:flex",
	}),
	columnHead(h, { label: "Last seen", sort: head(sort, "lastSeen"), align: "right", width: "w-24" }),
]

export const containerTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Containers" },
		columns(h, null),
		skeletonRows(h, 6, () => [
			h.div([h.Class("w-0 min-w-[260px] flex-1")], [skeleton(h, "h-4 w-48"), skeleton(h, "mt-1.5 h-3 w-40")]),
			h.div(
				[h.Class("hidden w-44 space-y-1.5 md:block")],
				[skeleton(h, "h-2.5 w-44"), skeleton(h, "h-2.5 w-44")],
			),
			skeleton(h, "hidden h-3 w-32 lg:block"),
			skeleton(h, "hidden h-3 w-32 lg:block"),
			skeleton(h, "h-3 w-24"),
		]),
	)

export type ContainerTableInputs = Readonly<{
	sortBy: ContainerSortKey
	sortDir: SortDir
	isWaiting: boolean
	referenceTime: string
	nowMs: number
	timeZone: string
}>

const containerRow = (h: H, container: ContainerRow, inputs: ContainerTableInputs): Html =>
	h.a(
		[
			h.Key(`${container.hostName}/${container.containerName}`),
			h.Href(
				hrefOf(
					AppRoute.InfraContainer({
						containerName: container.containerName,
						search: container.hostName ? { host: container.hostName } : {},
					}),
				),
			),
			h.Class(ROW_LINK_CLASS),
		],
		[
			h.div(
				[h.Class("w-0 min-w-[260px] flex-1")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							middleTruncate(h, {
								text: container.containerName,
								tail: 12,
								mono: true,
								className: "text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							}),
							hostStatusBadge(h, { quiet: true, lastSeen: container.lastSeen, referenceMs: inputs.referenceTime }),
						],
					),
					metaLine(h, [
						container.hostName && `host ${container.hostName}`,
						container.composeProject && `compose ${container.composeProject}`,
						container.imageName && `image ${container.imageName}`,
					]),
				],
			),
			h.div(
				[h.Class("hidden w-44 md:block")],
				[
					meterRows(h, [
						{ label: "CPU", fraction: container.cpuPctPeak },
						{ label: "MEM", fraction: container.memoryPctPeak },
					]),
				],
			),
			h.div(
				[h.Class("hidden w-32 text-right lg:block")],
				[avgPeak(h, { avg: container.cpuPct, peak: container.cpuPctPeak, format: formatWholePercent })],
			),
			h.div(
				[h.Class("hidden w-32 text-right lg:block")],
				[avgPeak(h, { avg: container.memoryPct, peak: container.memoryPctPeak, format: formatWholePercent })],
			),
			h.div(
				[h.Class("w-24 text-right")],
				[
					relativeTime(h, {
						value: container.lastSeen,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						mono: true,
						className: "cursor-default text-2xs text-muted-foreground",
					}),
				],
			),
		],
	)

export const containerTable = (h: H, containers: ReadonlyArray<ContainerRow>, inputs: ContainerTableInputs): Html =>
	dataTable(
		h,
		{ ariaLabel: "Containers", isWaiting: inputs.isWaiting },
		columns(h, { key: inputs.sortBy, dir: inputs.sortDir }),
		containers.length === 0
			? [dataTableEmpty(h, ["No containers match your filter."])]
			: containers.map((container) => containerRow(h, container, inputs)),
	)

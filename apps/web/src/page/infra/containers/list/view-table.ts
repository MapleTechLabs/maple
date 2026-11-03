import { formatWholePercent } from "../../../../components/infra/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { skeleton, skeletonLine } from "@maple/views/ui/skeleton"
import { avgPeak } from "../../kit/avg-peak"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	headSort,
	ROW_LINK_CLASS,
	skeletonRows,
} from "../../kit/data-table"
import type { SortDir } from "../../../kit/table-sort"
import { meterRows } from "../../kit/meter-rows"
import { metaLine } from "../../kit/meta-line"
import { listRelativeTime } from "../../../kit/relative-time"
import { hostStatusBadge } from "../../kit/status"
import { type ContainerSortKey, Message } from "./message"
import type { ContainerRow } from "./model"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { column, columnClass } from "@maple/views/ui/column"
import { Array as Arr } from "effect"

// `ContainerTable` / `ContainerTableLoading`.

type H = HtmlBuilder<Message>
type Sort = Readonly<{ key: string | null; dir: SortDir }> | null

const head = (sort: Sort, key: ContainerSortKey) =>
	headSort(sort, key, (k) => Message.ClickedSort({ key: k }))

const columns = (h: H, sort: Sort): ReadonlyArray<Html> => [
	columnHead(h, {
		label: "Container",
		sort: head(sort, "containerName"),
		width: columnClass({ min: "64" }),
	}),
	columnHead(h, {
		label: "Peak saturation",
		sort: head(sort, "saturation"),
		width: "w-44",
		hidden: "hidden md:flex",
	}),
	columnHead(h, {
		label: "CPU",
		sort: head(sort, "cpuPct"),
		align: "right",
		width: "w-32",
		hidden: "hidden lg:flex",
	}),
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
			column(h, { min: "64" }, [skeleton(h, "h-4 w-48"), skeleton(h, "mt-1.5 h-3 w-40")]),
			h.div(
				[h.Class("hidden w-44 space-y-1.5 md:block")],
				[skeleton(h, "h-2.5 w-44"), skeleton(h, "h-2.5 w-44")],
			),
			skeletonLine(h, { width: "32", visibleFrom: "lg" }),
			skeletonLine(h, { width: "32", visibleFrom: "lg" }),
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
			column(h, { min: "64" }, [
				hstack(h, { gap: "2" }, [
					middleTruncate(h, {
						text: container.containerName,
						tail: 12,
						mono: true,
						className: typographyClass({
							size: "xs",
							tone: "foreground",
							weight: "medium",
							className: "transition-colors group-hover:text-primary",
						}),
					}),
					hostStatusBadge(h, {
						quiet: true,
						lastSeen: container.lastSeen,
						referenceMs: inputs.referenceTime,
					}),
				]),
				metaLine(h, [
					container.hostName && `host ${container.hostName}`,
					container.composeProject && `compose ${container.composeProject}`,
					container.imageName && `image ${container.imageName}`,
				]),
			]),
			column(h, { width: "44", from: "md" }, [
				meterRows(h, [
					{ label: "CPU", fraction: container.cpuPctPeak },
					{ label: "MEM", fraction: container.memoryPctPeak },
				]),
			]),
			h.div(
				[h.Class("hidden w-32 text-right lg:block")],
				[
					avgPeak(h, {
						avg: container.cpuPct,
						peak: container.cpuPctPeak,
						format: formatWholePercent,
					}),
				],
			),
			h.div(
				[h.Class("hidden w-32 text-right lg:block")],
				[
					avgPeak(h, {
						avg: container.memoryPct,
						peak: container.memoryPctPeak,
						format: formatWholePercent,
					}),
				],
			),
			h.div(
				[h.Class("w-24 text-right")],
				[
					listRelativeTime(h, {
						value: container.lastSeen,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						mono: true,
						className: typographyClass({
							size: "2xs",
							tone: "muted",
							className: "cursor-default",
						}),
					}),
				],
			),
		],
	)

export const containerTable = (
	h: H,
	containers: ReadonlyArray<ContainerRow>,
	inputs: ContainerTableInputs,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Containers", isWaiting: inputs.isWaiting },
		columns(h, { key: inputs.sortBy, dir: inputs.sortDir }),
		containers.length === 0
			? [dataTableEmpty(h, ["No containers match these filters"])]
			: Arr.map(containers, (container) => containerRow(h, container, inputs)),
	)

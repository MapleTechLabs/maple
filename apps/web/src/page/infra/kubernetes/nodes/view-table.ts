import {
	capacityFraction,
	formatBytesOfAllocatable,
	formatCoresOfAllocatable,
} from "../../../../components/infra/format"
import { formatUptime } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { skeleton, skeletonLine } from "@maple/views/ui/skeleton"
import { truncatedText } from "@maple/views/ui/truncated-text"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	headSort,
	ROW_LINK_CLASS,
	skeletonRows,
} from "../../kit/data-table"
import { meterRows } from "../../kit/meter-rows"
import { metaLine } from "../../kit/meta-line"
import { listRelativeTime } from "../../../kit/relative-time"
import type { SortState } from "../../../kit/table-sort"
import { hostStatusBadge } from "../../kit/status"
import { Message, type NodeSortKey } from "./message"
import type { NodeRow } from "./model"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { column, columnClass } from "@maple/views/ui/column"

// `NodeTable` / `NodeTableLoading`.

type H = HtmlBuilder<Message>

const columns = (h: H, sort: SortState | null): ReadonlyArray<Html> => {
	const head = (key: NodeSortKey) => headSort(sort, key, (k) => Message.ClickedSort({ key: k }))
	return [
		columnHead(h, { label: "Node", sort: head("nodeName"), width: columnClass({ min: "64" }) }),
		columnHead(h, {
			label: "CPU / allocatable",
			sort: head("cpuUtilization"),
			width: "w-44",
			hidden: "hidden md:flex",
		}),
		columnHead(h, {
			label: "Memory / allocatable",
			sort: head("memoryUtilization"),
			width: "w-44",
			hidden: "hidden lg:flex",
		}),
		columnHead(h, {
			label: "Uptime",
			sort: head("uptime"),
			align: "right",
			width: "w-24",
			hidden: "hidden md:flex",
		}),
		columnHead(h, { label: "Last seen", sort: head("lastSeen"), align: "right", width: "w-24" }),
	]
}

export const nodeTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Nodes" },
		columns(h, null),
		skeletonRows(h, 4, () => [
			column(h, { min: "64" }, [
				skeleton(h, "h-4 w-48"),
				skeletonLine(h, { width: "32", className: "mt-1.5" }),
			]),
			skeleton(h, "hidden h-3 w-44 md:block"),
			skeleton(h, "hidden h-3 w-44 lg:block"),
			skeleton(h, "hidden h-3 w-24 md:block"),
			skeleton(h, "h-3 w-24"),
		]),
	)

/** `CapacityCell`: the meter answers "is this node full", the caption says of what. */
const capacityCell = (h: H, fraction: number, caption: string): Html =>
	h.div(
		[h.Class("space-y-1")],
		[
			meterRows(h, [{ label: "usage", fraction }], { hideLabels: true }),
			h.div([h.Class("truncate font-mono text-2xs tabular-nums text-muted-foreground")], [caption]),
		],
	)

export type NodeTableInputs = Readonly<{
	sort: SortState
	isWaiting: boolean
	referenceTime: string
	nowMs: number
	timeZone: string
}>

const nodeRow = (h: H, node: NodeRow, inputs: NodeTableInputs): Html =>
	h.a(
		[
			h.Key(node.nodeName),
			h.Href(hrefOf(AppRoute.InfraKubernetesNode({ nodeName: node.nodeName, search: {} }))),
			h.Class(ROW_LINK_CLASS),
		],
		[
			column(h, { min: "64" }, [
				hstack(h, { gap: "2" }, [
					truncatedText(h, {
						text: node.nodeName,
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
						lastSeen: node.lastSeen,
						referenceMs: inputs.referenceTime,
					}),
				]),
				metaLine(h, [node.kubeletVersion && `kubelet ${node.kubeletVersion}`]),
			]),
			column(h, { width: "44", from: "md" }, [
				capacityCell(
					h,
					capacityFraction(node.cpuUtilization, node.cpuAllocatable),
					formatCoresOfAllocatable(node.cpuUsage, node.cpuAllocatable),
				),
			]),
			h.div(
				[h.Class("hidden w-44 lg:block")],
				[
					capacityCell(
						h,
						capacityFraction(node.memoryUtilization, node.memoryAllocatable),
						formatBytesOfAllocatable(node.memoryUsage, node.memoryAllocatable),
					),
				],
			),
			h.div(
				[
					h.Class(
						"hidden w-24 text-right font-mono text-xs tabular-nums text-foreground-soft md:block",
					),
				],
				[formatUptime(node.uptime)],
			),
			h.div(
				[h.Class("w-24 text-right")],
				[
					listRelativeTime(h, {
						value: node.lastSeen,
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

export const nodeTable = (h: H, nodes: ReadonlyArray<NodeRow>, inputs: NodeTableInputs): Html =>
	dataTable(
		h,
		{ ariaLabel: "Nodes", isWaiting: inputs.isWaiting },
		columns(h, inputs.sort),
		nodes.length === 0
			? [dataTableEmpty(h, ["No nodes match your search"])]
			: nodes.map((node) => nodeRow(h, node, inputs)),
	)

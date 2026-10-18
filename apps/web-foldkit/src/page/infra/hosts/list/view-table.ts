import { formatLoad } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { middleTruncate } from "../../../../ui/middle-truncate"
import { skeleton } from "../../../../ui/skeleton"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	headSort,
	ROW_LINK_CLASS,
	skeletonRows,
} from "../../kit/data-table"
import { meterRows } from "../../kit/meter-rows"
import { metaLine, platformLabel } from "../../kit/meta-line"
import { relativeTime } from "../../kit/relative-time"
import type { SortState } from "../../../kit/table-sort"
import { hostStatusBadge } from "../../kit/status"
import { type HostSortKey, Message } from "./message"
import type { HostRow } from "./model"

// `HostTable` / `HostTableLoading` (apps/web/src/components/infra/host-table.tsx).

type H = HtmlBuilder<Message>

const sortOf = (sort: SortState | null, key: HostSortKey) =>
	headSort(sort, key, (k) => Message.ClickedSort({ key: k }))

/** `HostColumns`: interactive with `sort`, inert for the skeleton. */
const columns = (h: H, sort: SortState | null): ReadonlyArray<Html> => [
	columnHead(h, { label: "Host", sort: sortOf(sort, "hostName"), width: "w-0 flex-1 min-w-[260px]" }),
	columnHead(h, { label: "Usage", width: "w-[200px]" }),
	columnHead(h, {
		label: "Load 15m",
		sort: sortOf(sort, "load15"),
		align: "right",
		width: "w-[80px]",
		hidden: "hidden lg:flex",
	}),
	columnHead(h, { label: "Last seen", sort: sortOf(sort, "lastSeen"), align: "right", width: "w-[100px]" }),
]

export const hostTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Hosts" },
		columns(h, null),
		skeletonRows(h, 6, () => [
			h.div(
				[h.Class("w-0 min-w-[260px] flex-1")],
				[skeleton(h, "h-4 w-40"), skeleton(h, "mt-1.5 h-3 w-32")],
			),
			skeleton(h, "h-9 w-[200px]"),
			skeleton(h, "ml-auto hidden h-3 w-[80px] lg:block"),
			skeleton(h, "h-3 w-[100px]"),
		]),
	)

export type HostTableInputs = Readonly<{
	nowMs: number
	timeZone: string
	isWaiting: boolean
	sort: SortState
}>

const hostRow = (h: H, host: HostRow, inputs: HostTableInputs): Html =>
	h.a(
		[
			h.Key(host.hostName),
			h.Href(hrefOf(AppRoute.InfraHost({ hostName: host.hostName, search: {} }))),
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
								text: host.hostName,
								tail: 12,
								mono: true,
								className:
									"text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							}),
							hostStatusBadge(h, {
								quiet: true,
								lastSeen: host.lastSeen,
								referenceMs: inputs.nowMs,
							}),
						],
					),
					metaLine(h, [
						host.osType && platformLabel(h, "os", host.osType),
						host.hostArch && platformLabel(h, "arch", host.hostArch),
						host.cloudProvider && platformLabel(h, "cloud", host.cloudProvider),
					]),
				],
			),
			h.div(
				[h.Class("w-[200px]")],
				[
					meterRows(h, [
						{ label: "CPU", fraction: host.cpuPct },
						{ label: "MEM", fraction: host.memoryPct },
						{ label: "DSK", fraction: host.diskPct },
					]),
				],
			),
			h.div(
				[
					h.Class(
						"hidden w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80 lg:block",
					),
				],
				[formatLoad(host.load15)],
			),
			h.div(
				[h.Class("w-[100px] text-right")],
				[
					relativeTime(h, {
						value: host.lastSeen,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						mono: true,
						className: "cursor-default text-2xs text-muted-foreground",
					}),
				],
			),
		],
	)

export const hostTable = (h: H, hosts: ReadonlyArray<HostRow>, inputs: HostTableInputs): Html =>
	dataTable(
		h,
		{ ariaLabel: "Hosts", isWaiting: inputs.isWaiting },
		columns(h, inputs.sort),
		hosts.length === 0
			? [dataTableEmpty(h, "No hosts match your search.")]
			: hosts.map((host) => hostRow(h, host, inputs)),
	)

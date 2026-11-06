import { formatLoad } from "@maple/ui/lib/format"
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { skeleton, skeletonLine } from "@maple/views/ui/skeleton"
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
import { listRelativeTime } from "../../../kit/relative-time"
import type { SortDir, SortState } from "../../../kit/table-sort"
import { hostStatusBadge } from "../../kit/status"
import type { HostSortKey } from "./message"
import type { HostRow } from "./model"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { column, columnClass } from "@maple/views/ui/column"
import { Array as Arr } from "effect"

// `HostTable` / `HostTableLoading`, generic over the host's Message: /infra/hosts sorts through its Model,
// `/lab/worst-case` through its own.

type OnSort<M> = (key: HostSortKey) => M

const INERT_SORT = { isActive: false, dir: "desc" } satisfies Readonly<{ isActive: boolean; dir: SortDir }>

/** `HostColumns`: interactive with `sort`, inert for the skeleton. */
const columns = <M>(h: HtmlBuilder<M>, sort: SortState | null, onSort?: OnSort<M>): ReadonlyArray<Html> => {
	const sortOf = (key: HostSortKey) => (onSort === undefined ? INERT_SORT : headSort(sort, key, onSort))
	return [
		columnHead(h, { label: "Host", sort: sortOf("hostName"), width: columnClass({ min: "64" }) }),
		columnHead(h, { label: "Usage", width: "w-52" }),
		columnHead(h, {
			label: "Load 15m",
			sort: sortOf("load15"),
			align: "right",
			width: "w-20",
			hidden: "hidden lg:flex",
		}),
		columnHead(h, { label: "Last seen", sort: sortOf("lastSeen"), align: "right", width: "w-24" }),
	]
}

export const hostTableLoading = <M>(h: HtmlBuilder<M>): Html =>
	dataTable(
		h,
		{ ariaLabel: "Hosts" },
		columns<M>(h, null),
		skeletonRows(h, 6, () => [
			column(h, { min: "64" }, [
				skeleton(h, "h-4 w-40"),
				skeletonLine(h, { width: "32", className: "mt-1.5" }),
			]),
			skeleton(h, "h-9 w-52"),
			skeleton(h, "ml-auto hidden h-3 w-20 lg:block"),
			skeleton(h, "h-3 w-24"),
		]),
	)

export type HostTableInputs<M> = Readonly<{
	nowMs: number
	timeZone: string
	isWaiting: boolean
	sort: SortState
	onSort: OnSort<M>
}>

type RowInputs = Readonly<{ nowMs: number; timeZone: string }>

const hostRow = <M>(h: HtmlBuilder<M>, host: HostRow, inputs: RowInputs): Html =>
	h.a(
		[
			h.Key(host.hostName),
			h.Href(hrefOf(AppRoute.InfraHost({ hostName: host.hostName, search: {} }))),
			h.Class(ROW_LINK_CLASS),
		],
		[
			column(h, { min: "64" }, [
				hstack(h, { gap: "2" }, [
					middleTruncate(h, {
						text: host.hostName,
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
						lastSeen: host.lastSeen,
						referenceMs: inputs.nowMs,
					}),
				]),
				metaLine(h, [
					host.osType && platformLabel(h, "os", host.osType),
					host.hostArch && platformLabel(h, "arch", host.hostArch),
					host.cloudProvider && platformLabel(h, "cloud", host.cloudProvider),
				]),
			]),
			h.div(
				[h.Class("w-52")],
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
						"hidden w-20 text-right font-mono text-xs tabular-nums text-foreground-soft lg:block",
					),
				],
				[formatLoad(host.load15)],
			),
			h.div(
				[h.Class("w-24 text-right")],
				[
					listRelativeTime(h, {
						value: host.lastSeen,
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

// One cached row per host: a keystroke or sort re-renders only rows whose host or clock changed.
const lazyRow = createKeyedLazy()
const renderRow = <M>(h: HtmlBuilder<M>, host: HostRow, nowMs: number, timeZone: string): Html =>
	hostRow(h, host, { nowMs, timeZone })

export const hostTable = <M>(
	h: HtmlBuilder<M>,
	hosts: ReadonlyArray<HostRow>,
	inputs: HostTableInputs<M>,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Hosts", isWaiting: inputs.isWaiting },
		columns(h, inputs.sort, inputs.onSort),
		hosts.length === 0
			? [dataTableEmpty(h, ["No hosts match your search"])]
			: Arr.map(hosts, (host) =>
					lazyRow(host.hostName, renderRow, [h, host, inputs.nowMs, inputs.timeZone]),
				),
	)

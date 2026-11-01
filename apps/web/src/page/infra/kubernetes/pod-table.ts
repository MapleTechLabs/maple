import { formatCores, formatWholePercent } from "../../../components/infra/format"
import {
	formatRestarts,
	podKey,
	type PodRestartSummary,
	restartTone,
} from "../../../components/infra/pod-restarts"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { middleTruncate } from "../../../ui/middle-truncate"
import { skeleton } from "../../../ui/skeleton"
import { avgPeak } from "../kit/avg-peak"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	headSort,
	ROW_LINK_CLASS,
	skeletonRows,
} from "../kit/data-table"
import type { SortDir } from "../../kit/table-sort"
import { meterRows } from "../kit/meter-rows"
import { metaLine } from "../kit/meta-line"
import { listRelativeTime } from "../../kit/relative-time"
import { hostStatusBadge } from "../kit/status"
import type { TimeSearch } from "../kit/view-tabs"
import type { PodRow } from "./pod-data"

// `PodTable` / `PodTableLoading`.

export type PodSortKey = "saturation" | "cpuUsage" | "cpuLimitPct" | "memoryLimitPct" | "podName" | "lastSeen"
type Sort = Readonly<{ key: string | null; dir: SortDir }> | null

const workloadOf = (pod: PodRow): Readonly<{ kind: string; name: string }> | null => {
	if (pod.deploymentName) return { kind: "deploy", name: pod.deploymentName }
	if (pod.statefulsetName) return { kind: "sts", name: pod.statefulsetName }
	if (pod.daemonsetName) return { kind: "ds", name: pod.daemonsetName }
	if (pod.jobName) return { kind: "job", name: pod.jobName }
	return null
}

const metaTitle = (pod: PodRow, workload: Readonly<{ kind: string; name: string }> | null): string =>
	[
		pod.namespace && `ns ${pod.namespace}`,
		workload && `${workload.kind} ${workload.name}`,
		pod.nodeName && `node ${pod.nodeName}`,
		pod.qosClass && `qos ${pod.qosClass}`,
		pod.computeType === "fargate" && "fargate",
	]
		.filter(Boolean)
		.join(" · ")

const columns = <M>(
	h: HtmlBuilder<M>,
	sort: Sort,
	onSort: ((key: PodSortKey) => M) | undefined,
): ReadonlyArray<Html> => {
	const head = (key: PodSortKey) =>
		onSort === undefined || sort === null
			? { isActive: sort !== null && sort.key === key, dir: sort?.dir ?? "desc" }
			: headSort(sort, key, onSort)
	return [
		columnHead(h, { label: "Pod", sort: head("podName"), width: "w-0 flex-1 min-w-64" }),
		columnHead(h, {
			label: "Peak saturation",
			sort: head("saturation"),
			width: "w-44",
			hidden: "hidden md:flex",
		}),
		columnHead(h, {
			label: "CPU cores",
			sort: head("cpuUsage"),
			align: "right",
			width: "w-32",
			hidden: "hidden lg:flex",
		}),
		columnHead(h, {
			label: "Mem of limit",
			sort: head("memoryLimitPct"),
			align: "right",
			width: "w-32",
			hidden: "hidden lg:flex",
		}),
		columnHead(h, { label: "Last seen", sort: head("lastSeen"), align: "right", width: "w-24" }),
	]
}

export const podTableLoading = <M>(h: HtmlBuilder<M>): Html =>
	dataTable(
		h,
		{ ariaLabel: "Pods" },
		columns(h, null, undefined),
		skeletonRows(h, 6, () => [
			h.div(
				[h.Class("w-0 min-w-64 flex-1")],
				[skeleton(h, "h-4 w-48"), skeleton(h, "mt-1.5 h-3 w-40")],
			),
			h.div(
				[h.Class("hidden w-44 space-y-1.5 md:block")],
				[skeleton(h, "h-2.5 w-44"), skeleton(h, "h-2.5 w-44")],
			),
			skeleton(h, "hidden h-3 w-32 lg:block"),
			skeleton(h, "hidden h-3 w-32 lg:block"),
			skeleton(h, "h-3 w-24"),
		]),
	)

/** `RestartMarker`: beside the name, only when the pod restarted in the window. */
const restartMarker = <M>(h: HtmlBuilder<M>, summary: PodRestartSummary | undefined): Html => {
	if (summary === undefined || summary.restarts <= 0) return null
	const label = [formatRestarts(summary.restarts), summary.lastTerminatedReason].filter(Boolean).join(" · ")
	return h.span(
		[
			h.Class(
				cn(
					"shrink-0 text-2xs font-medium",
					TONE_TEXT[restartTone(summary.restarts, summary.lastTerminatedReason)],
				),
			),
			h.Title(`${label} in this window, ${summary.totalRestarts} in total`),
		],
		[label],
	)
}

export type PodTableInputs<M> = Readonly<{
	sortBy: PodSortKey
	sortDir: SortDir
	/** Absent for embedded lists: the heads show the server's order but do nothing. */
	onSort?: (key: PodSortKey) => M
	/** The row open in the peek sheet, by `podKey`; rows peek through `MountPodPeek`. */
	activeKey?: string
	/** Rows carry `data-peek-key` and plain clicks peek instead of navigating. */
	canPeek?: boolean
	timeSearch: TimeSearch
	isWaiting: boolean
	referenceTime: string
	nowMs: number
	timeZone: string
	restarts: Option.Option<ReadonlyMap<string, PodRestartSummary>>
}>

const podRow = <M>(h: HtmlBuilder<M>, pod: PodRow, inputs: PodTableInputs<M>): Html => {
	const workload = workloadOf(pod)
	const key = podKey(pod)
	const isActive = inputs.activeKey === key
	return h.a(
		[
			h.Key(key),
			h.Href(
				hrefOf(
					AppRoute.InfraKubernetesPod({
						podName: pod.podName,
						search: { ...inputs.timeSearch, namespace: pod.namespace || undefined },
					}),
				),
			),
			h.Class(cn(ROW_LINK_CLASS, rowSelectedClass(isActive))),
			...(isActive ? [h.DataAttribute("active", "true")] : []),
			...(inputs.canPeek === true ? [h.DataAttribute("peek-key", key)] : []),
		],
		[
			h.div(
				[h.Class("w-0 min-w-64 flex-1")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							middleTruncate(h, {
								text: pod.podName,
								tail: 12,
								mono: true,
								className:
									"text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							}),
							hostStatusBadge(h, {
								quiet: true,
								lastSeen: pod.lastSeen,
								referenceMs: inputs.referenceTime,
							}),
							restartMarker(
								h,
								Option.getOrUndefined(Option.map(inputs.restarts, (map) => map.get(key))),
							),
						],
					),
					metaLine(
						h,
						[
							pod.namespace && `ns ${pod.namespace}`,
							workload && `${workload.kind} ${workload.name}`,
							pod.nodeName && `node ${pod.nodeName}`,
							pod.qosClass && `qos ${pod.qosClass}`,
							pod.computeType === "fargate" && h.span([h.Class(TONE_TEXT.warn)], ["fargate"]),
						],
						{ title: metaTitle(pod, workload) },
					),
				],
			),
			h.div(
				[h.Class("hidden w-44 md:block")],
				[
					meterRows(h, [
						{ label: "CPU", fraction: pod.cpuLimitPctPeak },
						{ label: "MEM", fraction: pod.memoryLimitPctPeak },
					]),
				],
			),
			h.div(
				[h.Class("hidden w-32 text-right lg:block")],
				[avgPeak(h, { avg: pod.cpuUsage, peak: pod.cpuUsagePeak, format: formatCores })],
			),
			h.div(
				[h.Class("hidden w-32 text-right lg:block")],
				[
					avgPeak(h, {
						avg: pod.memoryLimitPct,
						peak: pod.memoryLimitPctPeak,
						format: formatWholePercent,
					}),
				],
			),
			h.div(
				[h.Class("w-24 text-right")],
				[
					listRelativeTime(h, {
						value: pod.lastSeen,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						mono: true,
						className: "cursor-default text-2xs text-muted-foreground",
					}),
				],
			),
		],
	)
}

export const podTable = <M>(
	h: HtmlBuilder<M>,
	pods: ReadonlyArray<PodRow>,
	inputs: PodTableInputs<M>,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Pods", isWaiting: inputs.isWaiting },
		columns(h, { key: inputs.sortBy, dir: inputs.sortDir }, inputs.onSort),
		pods.length === 0
			? [dataTableEmpty(h, ["No pods match your filter."])]
			: pods.map((pod) => podRow(h, pod, inputs)),
	)

import { restartTone } from "../../../../components/infra/pod-restarts"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { skeleton } from "../../../../ui/skeleton"
import { truncatedText } from "../../../../ui/truncated-text"
import { emptyValue } from "../../../../ui/values"
import { columnHead, dataTable, dataTableEmpty, headSort, ROW_LINK_CLASS, skeletonRows } from "../../kit/data-table"
import { meterRows } from "../../kit/meter-rows"
import { metaLine } from "../../kit/meta-line"
import { listRelativeTime } from "../../../kit/relative-time"
import type { SortState } from "../../../kit/table-sort"
import { hostStatusBadge } from "../../kit/status"
import { Message, type WorkloadSortKey } from "./message"
import type { WorkloadKind, WorkloadRow } from "./model"

// `WorkloadTable` / `WorkloadTableLoading`.

type H = HtmlBuilder<Message>

const columns = (h: H, sort: SortState | null, kind: WorkloadKind | undefined): ReadonlyArray<Html> => {
	const head = (key: WorkloadSortKey) => headSort(sort, key, (k) => Message.ClickedSort({ key: k }))
	return [
		columnHead(h, { label: "Workload", sort: head("workloadName"), width: "w-0 flex-1 min-w-64" }),
		columnHead(h, { label: kind === "job" ? "Completions" : "Ready", width: "w-28" }),
		columnHead(h, { label: "Pods", sort: head("podCount"), align: "right", width: "w-[60px]" }),
		columnHead(h, { label: "Restarts", sort: head("restarts"), align: "right", width: "w-36" }),
		columnHead(h, { label: "CPU peak", sort: head("peakCpuLimitPct"), align: "right", width: "w-36", hidden: "hidden md:flex" }),
		columnHead(h, {
			label: "Memory peak",
			sort: head("peakMemoryLimitPct"),
			align: "right",
			width: "w-36",
			hidden: "hidden lg:flex",
		}),
		columnHead(h, { label: "Last seen", sort: head("lastSeen"), align: "right", width: "w-24" }),
	]
}

export const workloadTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Workloads" },
		columns(h, null, undefined),
		skeletonRows(h, 4, () => [
			h.div([h.Class("w-0 min-w-64 flex-1")], [skeleton(h, "h-4 w-48"), skeleton(h, "mt-1.5 h-3 w-32")]),
			skeleton(h, "h-3 w-28"),
			skeleton(h, "h-3 w-[60px]"),
			skeleton(h, "h-3 w-36"),
			skeleton(h, "hidden h-3 w-36 md:block"),
			skeleton(h, "hidden h-3 w-36 lg:block"),
			skeleton(h, "h-3 w-24"),
		]),
	)

/** `ReplicaCell`: ready against desired; a job counts completions and reads its failures. */
const replicaCell = (h: H, workload: WorkloadRow, kind: WorkloadKind): Html => {
	const desired = workload.desiredReplicas
	const ready = workload.readyReplicas
	if (desired === null || ready === null) return emptyValue(h)
	const tone: Tone =
		kind === "job"
			? workload.failedPods > 0
				? "crit"
				: "neutral"
			: ready === 0 && desired > 0
				? "crit"
				: ready < desired
					? "warn"
					: "neutral"
	return h.span(
		[h.Class(TONE_TEXT[tone])],
		[
			String(ready),
			" / ",
			String(desired),
			...(kind === "job" && workload.failedPods > 0 ? [` · ${workload.failedPods} failed`] : []),
		],
	)
}

export type WorkloadTableInputs = Readonly<{
	kind: WorkloadKind
	sort: SortState
	isWaiting: boolean
	referenceTime: string
	nowMs: number
	timeZone: string
}>

const workloadRow = (h: H, wl: WorkloadRow, inputs: WorkloadTableInputs): Html =>
	h.a(
		[
			h.Key(`${wl.clusterName}/${wl.namespace}/${wl.workloadName}`),
			h.Href(
				hrefOf(
					AppRoute.InfraKubernetesWorkload({
						kind: inputs.kind,
						workloadName: wl.workloadName,
						search: wl.namespace ? { namespace: wl.namespace } : {},
					}),
				),
			),
			h.Class(ROW_LINK_CLASS),
		],
		[
			h.div(
				[h.Class("w-0 min-w-64 flex-1")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							truncatedText(h, {
								text: wl.workloadName,
								mono: true,
								className: "text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							}),
							hostStatusBadge(h, { quiet: true, lastSeen: wl.lastSeen, referenceMs: inputs.referenceTime }),
						],
					),
					metaLine(h, [wl.namespace && `ns ${wl.namespace}`, `kind ${inputs.kind}`]),
				],
			),
			h.div([h.Class("w-28 font-mono text-xs tabular-nums")], [replicaCell(h, wl, inputs.kind)]),
			h.div(
				[h.Class("w-[60px] text-right font-mono text-xs tabular-nums text-foreground-soft")],
				[wl.podCount.toLocaleString("en-US")],
			),
			h.div(
				[
					h.Class(
						cn(
							"flex w-36 flex-col items-end font-mono text-xs tabular-nums",
							TONE_TEXT[restartTone(wl.restarts, wl.lastTerminatedReason)],
						),
					),
				],
				[
					h.span([], [wl.restarts.toLocaleString("en-US")]),
					...(wl.restarts > 0 && wl.lastTerminatedReason
						? [h.span([h.Class("text-2xs text-muted-foreground")], [wl.lastTerminatedReason])]
						: []),
				],
			),
			h.div(
				[h.Class("hidden w-36 md:block")],
				[meterRows(h, [{ label: "CPU", fraction: wl.peakCpuLimitPct }], { hideLabels: true })],
			),
			h.div(
				[h.Class("hidden w-36 lg:block")],
				[meterRows(h, [{ label: "MEM", fraction: wl.peakMemoryLimitPct }], { hideLabels: true })],
			),
			h.div(
				[h.Class("w-24 text-right")],
				[
					listRelativeTime(h, {
						value: wl.lastSeen,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						mono: true,
						className: "cursor-default text-2xs text-muted-foreground",
					}),
				],
			),
		],
	)

export const workloadTable = (h: H, workloads: ReadonlyArray<WorkloadRow>, inputs: WorkloadTableInputs): Html =>
	dataTable(
		h,
		{ ariaLabel: "Workloads", isWaiting: inputs.isWaiting },
		columns(h, inputs.sort, inputs.kind),
		workloads.length === 0
			? [dataTableEmpty(h, ["No workloads match these filters"])]
			: workloads.map((wl) => workloadRow(h, wl, inputs)),
	)

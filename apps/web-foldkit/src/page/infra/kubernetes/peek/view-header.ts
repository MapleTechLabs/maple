import * as SheetStyles from "@maple/ui/styles/ui/sheet"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { descriptionId, titleId } from "../../../../ui/dialog"
import { dialogHeader } from "../../../../ui/dialog-view"
import { eyebrow } from "../../../../ui/eyebrow"
import { heroChip } from "../../kit/hero-chip"
import { relativeTime } from "../../../kit/relative-time"
import { hostStatusBadge } from "../../kit/status"
import type { PodRow } from "../pod-data"

// `SheetDetailHeader` as the peek uses it: the "Pod" eyebrow, the mono title with its status, and
// the workload chips.

export type HeaderInputs = Readonly<{ dialogId: string; referenceTime: string; nowMs: number; timeZone: string }>

const chip = <M>(h: HtmlBuilder<M>, prefix: string, value: string | null | undefined): ReadonlyArray<Html> =>
	value ? [heroChip(h, [`${prefix} `, value])] : []

export const peekHeader = <M>(h: HtmlBuilder<M>, pod: PodRow, inputs: HeaderInputs): Html => {
	const badge = hostStatusBadge(h, { quiet: true, lastSeen: pod.lastSeen, referenceMs: inputs.referenceTime })
	return dialogHeader(
		h,
		"sheet",
		[
			eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-x-2 gap-y-1" }, [
				h.span([h.Class("truncate")], ["Pod"]),
			]),
			h.h2(
				[
					h.Class(cn(SheetStyles.sheetTitleStyles, "flex flex-wrap items-center gap-2 text-title leading-tight font-mono")),
					h.DataAttribute("slot", "sheet-title"),
					h.Id(titleId(inputs.dialogId)),
				],
				[h.span([h.Class("min-w-0 break-all")], [pod.podName]), ...(badge === null ? [] : [badge])],
			),
			h.p(
				[
					h.Class(cn(SheetStyles.sheetDescriptionStyles, "sr-only")),
					h.DataAttribute("slot", "sheet-description"),
					h.Id(descriptionId(inputs.dialogId)),
				],
				[`Peak utilization and metrics for ${pod.podName}`],
			),
			h.div(
				[h.Class("flex flex-wrap items-center gap-1.5")],
				[
					...chip(h, "ns", pod.namespace),
					...chip(h, "deploy", pod.deploymentName),
					...chip(h, "sts", pod.statefulsetName),
					...chip(h, "ds", pod.daemonsetName),
					...chip(h, "job", pod.jobName),
					...chip(h, "node", pod.nodeName),
					...chip(h, "qos", pod.qosClass),
					relativeTime(h, {
						value: pod.lastSeen,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						prefix: "seen",
						mono: true,
						className: "ml-auto text-2xs text-muted-foreground",
					}),
				],
			),
		],
		"gap-1.5 pr-14",
	)
}

import type { Html, HtmlBuilder } from "foldkit/html"
import { heroChip } from "../../kit/hero-chip"
import { relativeTime } from "../../../kit/relative-time"
import { sheetDetailHeader } from "../../../kit/sheet-detail-header"
import { hostStatusBadge } from "../../kit/status"
import type { PodRow } from "../pod-data"

// The peek's `SheetDetailHeader`: the "Pod" eyebrow, the mono title with its status, and the
// workload chips.

export type HeaderInputs = Readonly<{
	dialogId: string
	referenceTime: string
	nowMs: number
	timeZone: string
}>

const chip = <M>(h: HtmlBuilder<M>, prefix: string, value: string | null | undefined): ReadonlyArray<Html> =>
	value ? [heroChip(h, [`${prefix} `, value])] : []

export const peekHeader = <M>(h: HtmlBuilder<M>, pod: PodRow, inputs: HeaderInputs): Html =>
	sheetDetailHeader(h, {
		dialogId: inputs.dialogId,
		kind: "Pod",
		title: [pod.podName],
		adornment: hostStatusBadge(h, {
			quiet: true,
			lastSeen: pod.lastSeen,
			referenceMs: inputs.referenceTime,
		}),
		description: `Peak utilization and metrics for ${pod.podName}`,
		meta: [
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
	})

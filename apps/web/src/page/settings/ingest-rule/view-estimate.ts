import type { V2IngestRulePreviewSignal } from "@maple/domain/http/v2"
import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { Message } from "./message"
import type { Model } from "./model"
import type { H } from "./view-form"

// The top of the preview panel: the draft counted over the last 24 hours of stored data.

const NOUNS = { logs: "logs", traces: "spans" } as const
const TOP_SERVICES = 3

const scannedLabel = (minutes: number) =>
	minutes % 60 === 0
		? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
		: `${minutes} ${minutes === 1 ? "minute" : "minutes"}`

const share = (part: number, total: number) =>
	total === 0 ? "0%" : `${Math.round((part / total) * 1000) / 10}%`

const signalLine = (h: H, entry: V2IngestRulePreviewSignal, isDrop: boolean): Html => {
	const noun = NOUNS[entry.signal]
	const counted = isDrop ? entry.estimated_dropped : entry.matched
	const verb = isDrop ? "Would drop" : "Matches"
	const services = Arr.take(entry.services, TOP_SERVICES)
	return vstack(h, { gap: "0.5" }, [
		typography(h, { size: "sm", weight: "medium", numeric: true, as: "p" }, [
			`${verb} ${formatNumber(counted)} of ${formatNumber(entry.stored)} ${noun} (${share(counted, entry.stored)})`,
		]),
		...(isDrop && entry.estimated_dropped_bytes > 0
			? [
					typography(h, { size: "xs", tone: "muted", numeric: true, as: "p" }, [
						`About ${formatStorageBytes(entry.estimated_dropped_bytes)} kept off the bill`,
					]),
				]
			: []),
		...(entry.scanned_minutes < 24 * 60
			? [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						`Rates from the last ${scannedLabel(entry.scanned_minutes)}, applied to the day`,
					]),
				]
			: []),
		...(services.length > 0 && entry.matched < entry.stored
			? [
					typography(h, { size: "xs", tone: "muted", numeric: true, truncate: true, as: "p" }, [
						Arr.join(
							Arr.map(
								services,
								(service) => `${service.service_name} ${formatNumber(service.matched)}`,
							),
							" · ",
						),
					]),
				]
			: []),
	])
}

/** Empty while the draft cannot be counted; the sample below says what to fix. */
export const estimateBlock = (h: H, model: Model): Html => {
	if (AsyncData.isIdle(model.estimate)) return h.div([], [])
	const isDrop = model.draft.actionType === "drop"
	return vstack(h, { gap: "2", className: "border-b px-4 py-3" }, [
		eyebrow(h, { as: "div" }, ["Last 24 hours, stored"]),
		AsyncData.matchData(model.estimate, {
			onEmpty: () => vstack(h, { gap: "1" }, [skeleton(h, "h-4 w-52"), skeleton(h, "h-3 w-32")]),
			onFailure: (failure) =>
				// A rule the preview cannot run (a pattern RE2 refuses) is an answer, not an outage.
				failure.code === "ingest_rule_invalid"
					? typography(h, { size: "xs", tone: "muted", as: "p" }, [failure.message])
					: hstack(h, { gap: "2", align: "center" }, [
							typography(h, { size: "xs", tone: "muted" }, [
								"Couldn't count the last 24 hours.",
							]),
							textLink(h, { onClick: Message.ClickedRetryEstimate() }, ["Try again"]),
						]),
			onData: (estimate) =>
				estimate.signals.length === 0
					? typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"Only logs and traces are counted.",
						])
					: vstack(
							h,
							{ gap: "2" },
							Arr.map(estimate.signals, (entry) => signalLine(h, entry, isDrop)),
						),
		}),
	])
}

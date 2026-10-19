import type { V2Source } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "../../../ui/status-dot"

// `SourceStatusBadge` (apps/web/src/components/sources/source-status.tsx).

export type SourceStatus = V2Source["health"]["status"]

const TONE = {
	pending: "neutral",
	healthy: "ok",
	stale: "warn",
	failing: "crit",
	paused: "warn",
	disconnected: "crit",
} as const satisfies Record<SourceStatus, "neutral" | "ok" | "warn" | "crit">

const LABEL = {
	pending: "Waiting for data",
	healthy: "Receiving",
	stale: "No recent data",
	failing: "Failing",
	paused: "Paused",
	disconnected: "Disconnected",
} as const satisfies Record<SourceStatus, string>

export const sourceStatusLabel = (status: SourceStatus): string => LABEL[status]

export type StatusBadgeOptions = Readonly<{
	nowMs: number
	/** Appends the relative time of the last data to "Receiving". */
	showTime?: boolean
	className?: string
}>

export const sourceStatusBadge = <M>(h: HtmlBuilder<M>, source: V2Source, options: StatusBadgeOptions): Html => {
	const { status, last_data_at: lastDataAt } = source.health
	const time =
		(options.showTime ?? true) && status === "healthy" && lastDataAt !== null
			? formatRelativeTime(lastDataAt, options.nowMs)
			: null
	return h.span(
		[h.Class(cn("inline-flex min-w-0 items-center gap-2 text-sm", options.className))],
		[
			statusDot(h, { tone: TONE[status], size: "lg" }),
			h.span(
				[h.Class("truncate")],
				[
					LABEL[status],
					...(time === null ? [] : [h.span([h.Class("text-muted-foreground")], [" ", "· ", time])]),
				],
			),
		],
	)
}

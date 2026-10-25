import type { V2Source } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "../../../ui/status-dot"

// `SourceStatusBadge`.

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

/** "1 of 3 unhealthy": a source that stands for several zones or repos, while some of them are not healthy. */
export const rollupLabel = (source: V2Source): string | null => {
	const resources = source.health.resources
	return resources === null || resources.unhealthy === 0 || source.health.status === "healthy"
		? null
		: `${resources.unhealthy} of ${resources.total} unhealthy`
}

/** Worst first, the order the list sorts by (`SOURCE_HEALTH_STATUSES`). */
const STATUS_RANK = {
	disconnected: 0,
	failing: 1,
	stale: 2,
	paused: 3,
	pending: 4,
	healthy: 5,
} as const satisfies Record<SourceStatus, number>

export const statusRank = (source: V2Source): number => STATUS_RANK[source.health.status]

/** Disconnected, failing or stale: something to fix. Paused and waiting are on purpose or new. */
export const needsAttention = (source: V2Source): boolean => statusRank(source) <= STATUS_RANK.stale

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
	const rollup = rollupLabel(source)
	const full = [LABEL[status], time, rollup].filter((part) => part !== null).join(" · ")
	return h.span(
		[h.Class(cn("inline-flex max-w-full min-w-0 items-center gap-2 text-sm", options.className))],
		[
			statusDot(h, { tone: TONE[status], size: "lg" }),
			h.span(
				[h.Class("truncate"), h.Title(full)],
				[
					LABEL[status],
					...(time === null ? [] : [h.span([h.Class("text-muted-foreground")], [" ", "· ", time])]),
					...(rollup === null ? [] : [h.span([h.Class("text-muted-foreground")], [" ", "· ", rollup])]),
				],
			),
		],
	)
}

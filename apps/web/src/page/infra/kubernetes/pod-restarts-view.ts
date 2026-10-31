import { restartTone, summarizePodRestarts } from "../../../components/infra/pod-restarts"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { columnHead, dataTable } from "../kit/data-table"
import { sectionHeading } from "../../kit/section-heading"
import { statRailItem, statRailItemSkeleton } from "../../kit/stat-rail"
import type { RestartRow } from "./pod-data"

// `PodRestartsStat` and `PodContainerRestarts`.

type Restarts = AsyncData.AsyncData<ReadonlyArray<RestartRow>, LoadFailure>

/** The restarts tile for the pod page's stat rail. */
export const podRestartsStat = <M>(h: HtmlBuilder<M>, restarts: Restarts): Html =>
	AsyncData.matchData(restarts, {
		onEmpty: () => statRailItemSkeleton(h),
		onFailure: () =>
			statRailItem(h, { eyebrow: "Restarts", value: EMPTY_VALUE, hint: "unavailable", compact: true }),
		onData: (rows) => {
			// No rows means the cluster collector isn't reporting this pod, not zero restarts.
			if (rows.length === 0)
				return statRailItem(h, {
					eyebrow: "Restarts",
					value: EMPTY_VALUE,
					hint: "not reported",
					compact: true,
				})
			const summary = summarizePodRestarts(rows).values().next().value
			const count = summary?.restarts ?? 0
			const reason = summary?.lastTerminatedReason ?? ""
			return statRailItem(h, {
				eyebrow: "Restarts",
				value: String(count),
				hint: `of ${summary?.totalRestarts ?? 0} total`,
				subline: reason ? `Last terminated: ${reason}` : undefined,
				tone: restartTone(count, reason),
				compact: true,
			})
		},
	})

const containerRow = <M>(h: HtmlBuilder<M>, row: RestartRow): Html =>
	h.div(
		[
			h.Key(row.containerName),
			h.Class("flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0"),
		],
		[
			h.span(
				[h.Class("w-0 min-w-52 flex-1 truncate font-mono text-xs text-foreground")],
				[row.containerName || EMPTY_VALUE],
			),
			h.span(
				[
					h.Class(
						cn(
							"w-24 text-right font-mono text-xs tabular-nums",
							TONE_TEXT[restartTone(row.restarts, row.lastTerminatedReason)],
						),
					),
				],
				[String(row.restarts)],
			),
			h.span(
				[h.Class("w-24 text-right font-mono text-xs tabular-nums text-muted-foreground")],
				[String(row.totalRestarts)],
			),
			h.span(
				[h.Class("w-40 truncate text-right text-xs text-muted-foreground")],
				[row.lastTerminatedReason || EMPTY_VALUE],
			),
		],
	)

/** Per-container breakdown, shown once any container has restarted or terminated. */
export const podContainerRestarts = <M>(h: HtmlBuilder<M>, restarts: Restarts): Html => {
	const rows = AsyncData.getOrElse(restarts, () => [])
	if (!rows.some((row) => row.totalRestarts > 0 || row.lastTerminatedReason !== "")) return null
	return h.div(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { as: "h3", title: "Container restarts", hint: "most restarts first" }),
			dataTable(
				h,
				{ ariaLabel: "Container restarts" },
				[
					columnHead(h, { label: "Container", width: "w-0 flex-1 min-w-52" }),
					columnHead(h, { label: "In window", align: "right", width: "w-24" }),
					columnHead(h, { label: "Total", align: "right", width: "w-24" }),
					columnHead(h, { label: "Last terminated", align: "right", width: "w-40" }),
				],
				rows.map((row) => containerRow(h, row)),
			),
		],
	)
}

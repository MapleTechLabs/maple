import { TONE_BORDER } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { IncidentTimelineEntry } from "@maple/web-data/alerts/incident-timeline"
import { formatDateInTimezone, formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { eyebrow } from "../../../ui/eyebrow"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { msIso } from "../shared/time"

// `IncidentTimeline`: the incident's events in order.

const sameDay = (a: number, b: number, timeZone: string): boolean =>
	formatDateInTimezone(a, { timeZone }) === formatDateInTimezone(b, { timeZone })

export const incidentTimeline = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		entries: ReadonlyArray<IncidentTimelineEntry>
		timeZone: string
		isLoading: boolean
		isFailed: boolean
	}>,
): Html => {
	const { timeZone } = options
	const firstAt = options.entries[0]?.at ?? 0
	return h.section(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h2" }, ["Timeline"]),
			h.ol(
				[h.Class("divide-y divide-border/60 border-t border-border/60")],
				[
					...options.entries.map((entry) => entryRow(h, entry, firstAt, timeZone)),
					...(options.isLoading ? [h.li([h.Class("py-3")], [skeleton(h, "h-4 w-2/3")])] : []),
				],
			),
			...(options.isFailed
				? [
						h.p(
							[h.Class("text-muted-foreground text-xs")],
							["Couldn't load delivery history, so notifications are missing."],
						),
					]
				: []),
		],
	)
}

const entryRow = <M>(h: HtmlBuilder<M>, entry: IncidentTimelineEntry, firstAt: number, timeZone: string): Html =>
	h.li(
		[h.Key(entry.key), h.Class("grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] gap-x-3 py-3")],
		[
			h.time(
				[
					h.Attribute("datetime", msIso(entry.at)),
					h.Class("pt-px font-mono text-muted-foreground text-xs tabular-nums"),
				],
				[
					sameDay(entry.at, firstAt, timeZone)
						? formatTimeInTimezone(entry.at, { timeZone })
						: `${formatDateInTimezone(entry.at, { timeZone })} ${formatTimeInTimezone(entry.at, { timeZone })}`,
				],
			),
			h.span(
				[h.Class("flex justify-center pt-1.5")],
				[
					entry.pending
						? h.span([h.AriaHidden(true), h.Class(cn("size-2 rounded-full border", TONE_BORDER[entry.tone]))])
						: statusDot(h, { tone: entry.tone, size: "lg" }),
				],
			),
			h.div(
				[h.Class("min-w-0 space-y-0.5")],
				[
					h.p([h.Class(cn("text-sm", entry.pending && "text-muted-foreground"))], [entry.title]),
					...(entry.detail ? [h.p([h.Class("text-muted-foreground text-xs")], [entry.detail])] : []),
					...(entry.investigation
						? [
								h.div(
									[h.Class("mt-2 space-y-2 rounded-md border bg-muted/30 px-3 py-2.5")],
									[
										...(entry.investigation.headline
											? [h.p([h.Class("text-sm leading-relaxed")], [entry.investigation.headline])]
											: []),
										h.a(
											[
												h.Href(hrefOf(AppRoute.Investigation({ id: String(entry.investigation.id), search: {} }))),
												h.Class("text-primary text-xs hover:underline"),
											],
											["Open investigation"],
										),
									],
								),
							]
						: []),
				],
			),
		],
	)

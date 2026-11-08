import { TONE_BORDER } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { IncidentTimelineEntry } from "@maple/web-data/alerts/incident-timeline"
import { formatDateInTimezone, formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { hstack } from "@maple/views/ui/stack"
import { dividedList } from "@maple/views/ui/rule"

// `IncidentTimeline`: the incident's events in order.

const sameDay = (a: number, b: number, timeZone: string): boolean =>
	formatDateInTimezone(a, { timeZone }) === formatDateInTimezone(b, { timeZone })

export const incidentTimeline = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		entries: ReadonlyArray<IncidentTimelineEntry>
		timeZone: string
		nowMs: number
		isLoading: boolean
		isFailed: boolean
	}>,
): Html => {
	const { timeZone, nowMs } = options
	const firstAt = options.entries[0]?.at ?? 0
	return h.section(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h2" }, ["Timeline"]),
			dividedList(
				h,
				{
					as: "ol",
					bordered: false,
					className: "divide-border-subtle border-t border-border-subtle",
				},
				[
					...Arr.map(options.entries, (entry) => entryRow(h, entry, firstAt, timeZone, nowMs)),
					...(options.isLoading ? [h.li([h.Class("py-3")], [skeleton(h, "h-4 w-2/3")])] : []),
				],
			),
			...(options.isFailed
				? [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"Couldn't load the whole history, so some notifications or acknowledgements are missing.",
						]),
					]
				: []),
		],
	)
}

const entryRow = <M>(
	h: HtmlBuilder<M>,
	entry: IncidentTimelineEntry,
	firstAt: number,
	timeZone: string,
	nowMs: number,
): Html =>
	h.li(
		[h.Key(entry.key), h.Class("grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] gap-x-3 py-3")],
		[
			timestamp(h, {
				value: entry.at,
				timeZone,
				nowMs,
				label: sameDay(entry.at, firstAt, timeZone)
					? formatTimeInTimezone(entry.at, { timeZone })
					: `${formatDateInTimezone(entry.at, { timeZone })} ${formatTimeInTimezone(entry.at, { timeZone })}`,
				mono: true,
				className: "pt-px text-muted-foreground text-xs",
			}),
			hstack(h, { align: "stretch", justify: "center", as: "span", className: "pt-1.5" }, [
				entry.pending
					? statusDot(h, {
							tone: "custom",
							size: "lg",
							className: cn("border", TONE_BORDER[entry.tone]),
						})
					: statusDot(h, { tone: entry.tone, size: "lg" }),
			]),
			h.div(
				[h.Class("min-w-0 space-y-0.5")],
				[
					h.p([h.Class(cn("text-sm", entry.pending && "text-muted-foreground"))], [entry.title]),
					...(entry.detail
						? [typography(h, { size: "xs", tone: "muted", as: "p" }, [entry.detail])]
						: []),
					...(entry.investigation
						? [
								h.div(
									[h.Class("mt-2 space-y-2 rounded-md border bg-surface-sunken p-3")],
									[
										...(entry.investigation.headline
											? [
													typography(
														h,
														{ size: "sm", as: "p", className: "leading-relaxed" },
														[entry.investigation.headline],
													),
												]
											: []),
										h.a(
											[
												h.Href(
													hrefOf(
														AppRoute.Investigation({
															id: String(entry.investigation.id),
															search: {},
														}),
													),
												),
												h.Class(
													typographyClass({
														size: "xs",
														tone: "primary",
														className: "hover:underline active:underline",
													}),
												),
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

import { TONE_BORDER, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { button } from "@maple/web/ui/button"
import { statusDot } from "@maple/web/ui/status-dot"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ShownData } from "../data/shown"
import type { TimeFormat } from "../page/kit/local-time"

// The stale data notice: says when the views
// show older results than the ones asked for, and why. Floats over the content.

const dayKey = (format: TimeFormat, ms: number) =>
	new Intl.DateTimeFormat("en-US", { timeZone: format.timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(ms)

/** `formatAsOf`: "20:14" today, "Oct 14, 20:14" before that. */
export const formatAsOf = (format: TimeFormat, ms: number, nowMs: number): string => {
	const isSameDay = dayKey(format, ms) === dayKey(format, nowMs)
	const options: Intl.DateTimeFormatOptions = isSameDay
		? { hour: "2-digit", minute: "2-digit" }
		: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
	return new Intl.DateTimeFormat(format.locale, { ...options, timeZone: format.timeZone }).format(ms)
}

export type Notice = Readonly<{ tone: Tone; text: string; isRetrying: boolean }>

/** `describeNotice`: none while nothing on screen is older than asked for. */
export const describeNotice = (
	input: Readonly<{ isDisconnected: boolean; isBusy: boolean; shown: ShownData; nowMs: number; timeFormat: TimeFormat }>,
): Notice | null => {
	const asOf = (ms: number | null) => (ms === null ? "" : ` Showing results from ${formatAsOf(input.timeFormat, ms, input.nowMs)}.`)
	const { shown } = input
	if (input.isDisconnected) return { tone: "crit", text: `Can’t reach Maple Local.${asOf(shown.shownAsOfMs)}`, isRetrying: true }
	if (shown.staleAsOfMs === null) return null
	if (shown.refreshFailed) return { tone: "warn", text: `Couldn’t refresh.${asOf(shown.staleAsOfMs)}`, isRetrying: true }
	if (input.isBusy) return { tone: "warn", text: `Maple Local is busy.${asOf(shown.staleAsOfMs)}`, isRetrying: false }
	return { tone: "neutral", text: `Loading newer results.${asOf(shown.staleAsOfMs)}`, isRetrying: false }
}

export const staleNotice = <M>(h: HtmlBuilder<M>, notice: Notice, onRetry: M): Html =>
	h.div(
		[h.Class("pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4")],
		[
			h.output(
				[
					h.Class(
						cn(
							"stale-notice pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-popover py-1 pr-1 pl-3 text-xs text-popover-foreground shadow-sm",
							TONE_BORDER[notice.tone],
							!notice.isRetrying && "pr-3",
						),
					),
				],
				[
					statusDot(h, { tone: notice.tone }),
					h.span([h.Class("truncate")], [notice.text]),
					...(notice.isRetrying
						? [button(h, { variant: "ghost", size: "xs", className: "rounded-full", attributes: [h.OnClick(onRetry)] }, ["Try again"])]
						: []),
				],
			),
		],
	)

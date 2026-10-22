import { formatUtcTitle } from "../../lib/time"
import { formatDateTime, type TimeFormat } from "../kit/local-time"
import { isLocalSessionLive, localSessionDurationMs } from "../../lib/session-liveness"
import { shortId } from "@maple/ui/lib/ids"
import { initialsFrom } from "@maple/ui/lib/initials"
import { gradientFor, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { badge } from "@maple/web/ui/display"
import { icon, type IconName } from "@maple/web/ui/icon"
import { statusDot } from "@maple/web/ui/status-dot"
import { DateTime } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SessionRow } from "./model"

// One session's card in the list.

const stat = <M>(h: HtmlBuilder<M>, name: IconName, value: number, title: string): Html =>
	h.span(
		[h.Class("inline-flex items-center gap-1 tabular-nums"), h.Title(title)],
		[h.span([h.Class("opacity-60")], [icon(h, name, { className: "size-3.5" })]), String(value)],
	)

const playGlyph = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		[
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("class", "size-3.5 translate-x-px fill-current"),
			h.Attribute("aria-hidden", "true"),
		],
		[h.path([h.Attribute("d", "M8 5v14l11-7z")])],
	)

const identity = <M>(h: HtmlBuilder<M>, session: SessionRow, label: string, isActive: boolean): Html =>
	h.div(
		[h.Class("min-w-0 flex-1")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					h.span([h.Class("max-w-[16rem] truncate text-sm font-medium")], [label]),
					statusDot(h, {
						tone: isActive ? "ok" : "neutral",
						attributes: [h.Title(isActive ? "active" : "ended")],
					}),
					h.span(
						[h.Class("font-mono text-xs text-muted-foreground")],
						[
							shortId(session.sessionId, "session", { length: 8 }),
							" ·",
							" ",
							formatSessionDuration(localSessionDurationMs(session)),
						],
					),
				],
			),
			h.div(
				[h.Class("mt-1 flex items-center gap-3 text-xs text-muted-foreground")],
				[
					h.span(
						[h.Class("flex min-w-0 items-center gap-1.5")],
						[
							icon(h, "GlobeIcon", { className: "size-3.5 shrink-0 opacity-60" }),
							h.span([h.Class("max-w-[18rem] truncate")], [hostFromUrl(session.urlInitial)]),
						],
					),
					h.span(
						[h.Class("hidden items-center gap-1.5 sm:flex")],
						[
							icon(h, isMobileDevice(session.deviceType) ? "MobileIcon" : "ComputerIcon", {
								className: "size-3.5 shrink-0 opacity-60",
							}),
							h.span(
								[h.Class("truncate")],
								[
									session.browserName || "Unknown",
									...(session.osName ? [` · ${session.osName}`] : []),
								],
							),
						],
					),
				],
			),
		],
	)

const counts = <M>(h: HtmlBuilder<M>, session: SessionRow): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground")],
		[
			stat(h, "PulseIcon", session.clickCount, "clicks"),
			stat(h, "EyeIcon", session.pageViews || 1, "page views"),
			...(session.traceCount > 0
				? [
						badge(h, { pill: true, className: "bg-primary/10 tabular-nums text-primary" }, [
							String(session.traceCount),
							" trace",
							session.traceCount === 1 ? "" : "s",
						]),
					]
				: []),
			...(session.errorCount > 0
				? [
						badge(
							h,
							{
								pill: true,
								className: "bg-severity-error/10 tabular-nums text-severity-error",
							},
							[
								icon(h, "CircleWarningIcon", { className: "size-3" }),
								String(session.errorCount),
							],
						),
					]
				: []),
		],
	)

export const sessionCard = <M>(
	h: HtmlBuilder<M>,
	session: SessionRow,
	href: string,
	nowMs: number,
	timeFormat: TimeFormat,
): Html => {
	const label = session.userName || session.userEmail || session.userId || "Anonymous"
	const isActive = isLocalSessionLive(session, nowMs)
	return h.a(
		[
			h.Href(href),
			h.Class(
				"group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			),
		],
		[
			h.div(
				[
					h.Class(
						`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(session.sessionId)} text-sm font-semibold text-white shadow-sm`,
					),
				],
				[initialsFrom(label)],
			),
			identity(h, session, label, isActive),
			counts(h, session),
			h.div(
				[h.Class("flex shrink-0 items-center gap-3")],
				[
					h.span(
						[
							h.Class(
								"inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground",
							),
							h.Title(
								`${formatDateTime(timeFormat, session.startTime)} (${formatUtcTitle(session.startTime)})`,
							),
						],
						[
							icon(h, "ClockIcon", { className: "size-3.5 opacity-60" }),
							formatRelativeFrom(DateTime.toEpochMillis(session.startTime), nowMs),
						],
					),
					h.span(
						[
							h.Class(
								"grid size-7 place-items-center rounded-full bg-primary/10 text-primary opacity-0 transition-opacity group-hover:opacity-100",
							),
						],
						[playGlyph(h)],
					),
				],
			),
		],
	)
}

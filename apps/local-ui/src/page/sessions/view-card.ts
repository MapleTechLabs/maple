import type { TimeFormat } from "../kit/local-time"
import { isLocalSessionLive, localSessionDurationMs } from "../../lib/session-liveness"
import { shortId } from "@maple/ui/lib/ids"
import { initialsFrom } from "@maple/ui/lib/initials"
import { gradientFor, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { timestamp } from "@maple/views/ui/timestamp"
import { badge } from "@maple/views/ui/display"
import { icon, type IconName } from "@maple/views/ui/icon"
import { selectableRow } from "@maple/views/ui/selectable-row"
import { hstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { DateTime } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SessionRow } from "./model"
import { nonZeroOr } from "@maple/ui/lib/number"

// One session's card in the list.

const stat = <M>(h: HtmlBuilder<M>, name: IconName, value: number, title: string): Html =>
	hstack(
		h,
		{ as: "span", inline: true, gap: "1", className: "tabular-nums", attributes: [h.Title(title)] },
		[icon(h, name, { className: "size-3.5" }), String(value)],
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
			hstack(h, { gap: "2" }, [
				typography(h, { size: "sm", weight: "medium", truncate: true, className: "max-w-[16rem]" }, [
					label,
				]),
				statusDot(h, {
					tone: isActive ? "ok" : "neutral",
					attributes: [h.Title(isActive ? "active" : "ended")],
				}),
				typography(h, { size: "xs", tone: "muted", mono: true }, [
					shortId(session.sessionId, "session", { length: 8 }),
					" ·",
					" ",
					formatSessionDuration(localSessionDurationMs(session)),
				]),
			]),
			hstack(h, { gap: "3", className: "mt-1 text-xs text-muted-foreground" }, [
				hstack(h, { as: "span", gap: "1.5", shrink: true }, [
					icon(h, "GlobeIcon", { className: "size-3.5 shrink-0" }),
					typography(h, { truncate: true, className: "max-w-[18rem]" }, [
						hostFromUrl(session.urlInitial),
					]),
				]),
				h.span(
					[h.Class("hidden items-center gap-1.5 sm:flex")],
					[
						icon(h, isMobileDevice(session.deviceType) ? "MobileIcon" : "ComputerIcon", {
							className: "size-3.5 shrink-0",
						}),
						typography(h, { truncate: true }, [
							session.browserName || "Unknown",
							...(session.osName ? [` · ${session.osName}`] : []),
						]),
					],
				),
			]),
		],
	)

const counts = <M>(h: HtmlBuilder<M>, session: SessionRow): Html =>
	hstack(h, { gap: "2.5", className: "shrink-0 text-xs text-muted-foreground" }, [
		stat(h, "PulseIcon", session.clickCount, "clicks"),
		stat(h, "EyeIcon", nonZeroOr(session.pageViews, 1), "page views"),
		...(session.traceCount > 0
			? [
					badge(h, { pill: true, className: "bg-primary-a2 tabular-nums text-primary" }, [
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
						{ pill: true, className: "bg-severity-error-a2 tabular-nums text-severity-error" },
						[icon(h, "CircleWarningIcon", { className: "size-3" }), String(session.errorCount)],
					),
				]
			: []),
	])

export const sessionCard = <M>(
	h: HtmlBuilder<M>,
	session: SessionRow,
	href: string,
	nowMs: number,
	timeFormat: TimeFormat,
): Html => {
	const label = session.userName || session.userEmail || session.userId || "Anonymous"
	const isActive = isLocalSessionLive(session, nowMs)
	return selectableRow(
		h,
		{
			isSelected: false,
			href,
			className:
				"group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 text-left transition-[translate] hover:-translate-y-px active:-translate-y-px hover:border-primary-a4 active:border-primary-a4 hover:bg-accent/40 active:bg-accent/40 hover:shadow-raised active:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
		},
		[
			h.div(
				[
					h.Class(
						`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(session.sessionId)} text-sm font-semibold text-on-fill shadow-raised`,
					),
				],
				[initialsFrom(label)],
			),
			identity(h, session, label, isActive),
			counts(h, session),
			hstack(h, { gap: "3", className: "shrink-0" }, [
				hstack(
					h,
					{
						as: "span",
						inline: true,
						gap: "1.5",
						className: "whitespace-nowrap text-sm text-muted-foreground",
					},
					[
						icon(h, "ClockIcon", { className: "size-3.5" }),
						timestamp(h, {
							value: DateTime.toEpochMillis(session.startTime),
							format: "relative",
							nowMs,
							timeZone: timeFormat.timeZone,
							className: "cursor-pointer",
						}),
					],
				),
				h.span(
					[
						h.Class(
							"grid size-7 place-items-center rounded-full bg-primary-a2 text-primary opacity-0 transition-opacity group-hover:opacity-100",
						),
					],
					[playGlyph(h)],
				),
			]),
		],
	)
}

import type { SessionTag } from "@maple/domain/query-engine"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { formatSessionDuration, isSessionLive, sessionDurationMs } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"
import {
	SESSION_TAG_DESCRIPTIONS,
	SESSION_TAG_LABELS,
	SESSION_TAG_ORDER,
	SESSION_TAG_STYLES,
} from "../../../components/replays/session-tags"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { pressable } from "../../../ui/pressable"
import { textLink } from "../../../ui/text-link"
import { truncatedText } from "../../../ui/truncated-text"
import { relativeTime } from "../../kit/relative-time"
import type { SessionRow } from "./session-row"
import {
	browserIconFor,
	COLUMNS,
	deviceIconFor,
	errorCountPill,
	livePill,
	type SessionsListOptions,
} from "./sessions-parts"

// A session list row: its org button, tags and badges.

const identityLabel = (session: SessionRow): string =>
	session.userName || session.userEmail || session.userId || "Anonymous"

const orgButton = <M>(
	h: HtmlBuilder<M>,
	name: string,
	onFilter: ((group: string) => M) | undefined,
): Html => {
	const className = "min-w-0 truncate text-xs font-medium text-foreground"
	if (onFilter === undefined) return h.span([h.Class(className)], [name])
	return textLink(
		h,
		{
			tone: "muted",
			onClick: onFilter(name),
			clickOptions: { propagation: "Stop" },
			className: cn(className, "block rounded-sm text-left"),
		},
		[name],
	)
}

const sessionTags = <M>(
	h: HtmlBuilder<M>,
	tags: ReadonlyArray<SessionTag>,
	onFilter: ((tag: SessionTag) => M) | undefined,
): ReadonlyArray<Html> =>
	SESSION_TAG_ORDER.filter((tag) => tags.includes(tag)).map((tag) => {
		return onFilter === undefined
			? badge(
					h,
					{
						pill: true,
						size: "xs",
						className: SESSION_TAG_STYLES[tag],
						attributes: [h.Title(SESSION_TAG_DESCRIPTIONS[tag])],
					},
					[SESSION_TAG_LABELS[tag]],
				)
			: badge(
					h,
					{
						pill: true,
						size: "xs",
						className: cn(
							SESSION_TAG_STYLES[tag],
							"hover:ring-1 active:ring-1 hover:ring-border active:ring-border",
						),
						onClick: onFilter(tag),
						clickOptions: { propagation: "Stop" },
					},
					[SESSION_TAG_LABELS[tag]],
				)
	})

const sessionBadges = <M>(h: HtmlBuilder<M>, session: SessionRow): ReadonlyArray<Html> => [
	...(session.errorCount > 0 ? [errorCountPill(h, session.errorCount)] : []),
	...(session.traceCount > 0
		? [
				badge(h, { variant: "meta", pill: true, size: "xs", mono: true }, [
					countLabel(session.traceCount, "trace"),
				]),
			]
		: []),
	...(session.recorded === "false"
		? [
				badge(
					h,
					{ variant: "meta", pill: true, size: "xs", className: "border-dashed border-border" },
					["Transcript only"],
				),
			]
		: []),
]

const longBadge = <M>(h: HtmlBuilder<M>, p95: number): Html =>
	badge(
		h,
		{
			variant: "muted",
			pill: true,
			size: "xs",
			className: "self-center bg-accent text-accent-foreground",
			attributes: [
				h.Title(`Longer than 95% of sessions in this view (p95: ${formatSessionDuration(p95)})`),
			],
		},
		["long"],
	)

/** The user column: name, then email or entry page; below @2xl the other columns stack under it. */
const userColumn = <M>(
	h: HtmlBuilder<M>,
	options: SessionsListOptions<M>,
	session: SessionRow,
	muted: boolean,
): Html => {
	const label = identityLabel(session)
	const entry = hostFromUrl(session.urlInitial)
	const secondary = session.userEmail && session.userEmail !== label ? session.userEmail : entry
	return h.div(
		[h.Class("relative min-w-0 flex-1 overflow-hidden")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					h.span(
						[
							h.Class(
								cn("min-w-0 truncate text-sm font-medium", muted && "text-muted-foreground"),
							),
							h.Title(label),
						],
						[label],
					),
					...(isSessionLive(session, options.nowMs) ? [livePill(h, true)] : []),
					startedAt(
						h,
						options,
						session,
						"ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden",
					),
				],
			),
			truncatedText(
				h,
				{ text: entry, mono: secondary === entry, className: "mt-0.5 text-xs text-muted-foreground" },
				[secondary],
			),
			h.div(
				[
					h.Class(
						cn(
							"mt-1.5 flex flex-wrap items-center gap-1.5",
							session.groupName ? "@3xl:hidden" : "@2xl:hidden",
						),
					),
				],
				[
					...(session.groupName ? [orgButton(h, session.groupName, options.onFilterGroup)] : []),
					h.div(
						[h.Class("contents @2xl:hidden")],
						[...sessionTags(h, session.tags, options.onFilterTag), ...sessionBadges(h, session)],
					),
				],
			),
		],
	)
}

/** One session: a stretched button opens it, the columns sit above it and their clicks bubble to the row. */
export const sessionListRow = <M>(
	h: HtmlBuilder<M>,
	options: SessionsListOptions<M>,
	session: SessionRow,
	lowSignal: boolean,
): Html => {
	const durationMs = sessionDurationMs(session)
	const p95 = options.durationP95
	const open = options.onOpen(session)
	return h.div(
		[
			h.OnClick(open),
			h.Class(
				cn(
					"group relative flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 hover:bg-surface-sunken active:bg-surface-sunken @2xl:gap-4",
					lowSignal ? "py-1.5" : "py-2.5",
				),
			),
		],
		[
			pressable(
				h,
				{
					label: `Open session from ${identityLabel(session)}`,
					className: "absolute inset-0 focus-visible:ring-inset focus-visible:ring-ring",
					attributes: [h.OnClick(open, { propagation: "Stop" })],
				},
				[],
			),
			...(session.errorCount > 0
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class("absolute inset-y-0 left-0 w-[3px] bg-severity-error"),
							],
							[],
						),
					]
				: []),
			userColumn(h, options, session, lowSignal || session.recorded === "false"),
			h.div(
				[h.Class(cn(COLUMNS.org, "relative min-w-0 items-center"))],
				[
					session.groupName
						? orgButton(h, session.groupName, options.onFilterGroup)
						: h.span([h.Class("text-xs text-foreground-faint")], [EMPTY_VALUE]),
				],
			),
			h.div(
				[h.Class(cn(COLUMNS.tags, "relative flex-wrap items-center gap-1"))],
				sessionTags(h, session.tags, options.onFilterTag),
			),
			h.div(
				// A long session's counts drop to a second line instead of losing the clicks to an ellipsis.
				[
					h.Class(
						cn(
							COLUMNS.activity,
							"relative flex-wrap content-center items-baseline gap-x-2 gap-y-0.5",
						),
					),
				],
				[
					h.span(
						[
							h.Class(
								cn(
									"whitespace-nowrap font-mono text-sm font-semibold tabular-nums",
									lowSignal && "font-normal text-muted-foreground",
								),
							),
						],
						[formatSessionDuration(durationMs)],
					),
					...(p95 !== undefined && p95 > 0 && durationMs !== null && durationMs > p95
						? [longBadge(h, p95)]
						: []),
					h.span(
						[h.Class("whitespace-nowrap text-xs text-muted-foreground")],
						[
							countLabel(session.pageViews || 1, "page"),
							" · ",
							countLabel(session.clickCount, "click"),
						],
					),
				],
			),
			deviceColumn(h, session),
			h.div(
				// Wraps rather than clips: a cut pill loses its rounded end and its count.
				[h.Class(cn(COLUMNS.signals, "relative flex-wrap content-center items-center gap-1.5"))],
				sessionBadges(h, session),
			),
			h.div(
				[h.Class(cn(COLUMNS.time, "relative items-center"))],
				[startedAt(h, options, session, "whitespace-nowrap text-xs text-muted-foreground")],
			),
		],
	)
}

const deviceColumn = <M>(h: HtmlBuilder<M>, session: SessionRow): Html =>
	h.div(
		[h.Class(cn(COLUMNS.device, "relative items-center gap-2.5"))],
		[
			h.span(
				[
					h.Class("shrink-0"),
					h.Title(
						`${session.browserName || "Unknown"}${session.osName ? ` · ${session.osName}` : ""}`,
					),
				],
				[icon(h, browserIconFor(session.browserName), { className: "size-4" })],
			),
			h.span(
				[h.Class("shrink-0 text-muted-foreground"), h.Title(session.deviceType || "desktop")],
				[icon(h, deviceIconFor(session.deviceType), { className: "size-4" })],
			),
			...(session.country
				? [h.span([h.Class("truncate text-xs text-muted-foreground")], [session.country])]
				: []),
		],
	)

const startedAt = <M>(
	h: HtmlBuilder<M>,
	options: SessionsListOptions<M>,
	session: SessionRow,
	className: string,
) =>
	relativeTime(h, {
		value: session.startTime,
		nowMs: options.nowMs,
		timeZone: options.timeZone,
		variant: "orDate",
		tooltip: "title",
		className,
	})

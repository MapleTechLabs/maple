import { sessionLinkWindow, sessionRowId } from "@maple/agent-sessions"
import type { AiSessionListItem } from "@maple/domain/http"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { TONE_BORDER, TONE_FILL, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import { orderedSearch } from "../../../route/tanstack-search"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { skeletonList } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { vendorLabel } from "../kit/vendor"
import { relativeTime } from "../../kit/relative-time"
import type { Message } from "./message"

type H = HtmlBuilder<Message>

type SessionRow = typeof AiSessionListItem.Type

/** A session's error count pill. */
const errorCountPill = (h: H, count: number): Html =>
	badge(
		h,
		{ pill: true, size: "xs", mono: true, className: cn("gap-1.5", TONE_SOFT.crit, TONE_BORDER.crit) },
		[statusDot(h, { tone: "crit", size: "sm" }), countLabel(count, "error")],
	)

const sessionRow = (h: H, session: SessionRow, tool: string, nowMs: number, timeZone: string): Html => {
	const hasErrors = session.errorSpanCount > 0
	return h.a(
		[
			h.Key(session.sessionId),
			h.Class(
				"relative flex w-full items-center gap-4 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
			),
			// `{ ...sessionLinkWindow(session), tool, view }` in that order.
			h.Href(
				`${hrefOf(AppRoute.AgentSession({ sessionId: session.sessionId, search: {} }))}${orderedSearch(
					[
						["t", sessionLinkWindow(session).t],
						["end", sessionLinkWindow(session).end],
						["tool", tool],
						["view", "trace"],
					],
				)}`,
			),
		],
		[
			...(hasErrors
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class(`absolute inset-y-0 left-0 w-[3px] ${TONE_FILL.crit}`),
							],
							[],
						),
					]
				: []),
			h.span(
				[h.Class("flex w-0 min-w-0 flex-1 flex-col gap-px")],
				[
					h.span(
						[
							h.Class("truncate font-mono text-sm font-medium leading-4.5 text-foreground"),
							h.Title(session.sessionId),
						],
						[sessionRowId(session.sessionId)],
					),
					h.span(
						[h.Class("truncate text-xs text-muted-foreground")],
						[vendorLabel(session.vendorId)],
					),
				],
			),
			h.span(
				[
					h.Class(
						"hidden w-44 shrink-0 truncate text-xs text-muted-foreground @min-[720px]/panel:block",
					),
				],
				[[session.firstAgentName, ...session.serviceNames].filter((part) => part !== "").join(" · ")],
			),
			h.span(
				[h.Class("hidden w-56 shrink-0 items-baseline gap-2 @min-[560px]/panel:flex")],
				[
					h.span(
						[h.Class("font-mono text-ui font-semibold tabular-nums text-foreground")],
						[formatSessionDuration(session.durationMs)],
					),
					h.span(
						[h.Class("truncate text-xs text-muted-foreground")],
						[
							countLabel(session.traceCount, "trace"),
							" ·",
							" ",
							countLabel(session.spanCount, "span"),
						],
					),
				],
			),
			h.span(
				[h.Class("hidden w-36 shrink-0 @min-[900px]/panel:flex")],
				hasErrors ? [errorCountPill(h, session.errorSpanCount)] : [],
			),
			relativeTime(h, {
				value: toEpochMs(session.startTime),
				variant: "orDate",
				tooltip: "tooltip",
				nowMs,
				timeZone,
				className: "shrink-0 whitespace-nowrap text-xs text-muted-foreground",
			}),
		],
	)
}

export type SessionsPanelInputs = Readonly<{
	rows: ReadonlyArray<SessionRow>
	tool: string
	isCapped: boolean
	isLoading: boolean
	failure: LoadFailure | undefined
	isWaiting: boolean
	nowMs: number
	timeZone: string
}>

export const sessionsPanel = (h: H, inputs: SessionsPanelInputs): Html =>
	h.section(
		[
			h.AriaLabel(`Sessions running ${inputs.tool}`),
			h.Class("@container/panel border-b border-border px-6 pt-5 pb-6"),
		],
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-4 pb-3")],
				[
					h.div(
						[h.Class("flex min-w-0 items-baseline gap-2.5 font-mono")],
						[
							h.span(
								[h.Class("text-xs font-medium text-foreground")],
								["Sessions running ", inputs.tool],
							),
							h.span(
								[h.Class("text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
								[countLabel(inputs.rows.length, "session")],
							),
						],
					),
					linkButton(
						h,
						{
							variant: "outline",
							size: "xs",
							className: "font-mono text-2xs sm:text-2xs",
							href: hrefOf(AppRoute.AgentSessions({ search: { tools: [inputs.tool] } })),
						},
						[
							"Open in Sessions",
							icon(h, "ExternalLinkIcon", {
								size: 12,
								className: "text-muted-foreground",
								attributes: [h.AriaHidden(true)],
							}),
						],
					),
				],
			),
			h.div(
				[h.Class(refreshingClass(inputs.isWaiting)), ...(inputs.isWaiting ? [h.AriaBusy(true)] : [])],
				inputs.failure !== undefined
					? [
							errorState(h, {
								failure: inputs.failure,
								title: `Couldn't load sessions running ${inputs.tool}`,
							}),
						]
					: inputs.isLoading
						? [skeletonList(h, { rows: 3, rowClassName: "h-[46px]", className: "gap-1.5 py-3" })]
						: inputs.rows.length === 0
							? [
									emptyMessage(h, { className: "py-12 font-mono" }, [
										"No sessions called ",
										inputs.tool,
										" in this window",
									]),
								]
							: inputs.rows.map((session) =>
									sessionRow(h, session, inputs.tool, inputs.nowMs, inputs.timeZone),
								),
			),
			...(inputs.isCapped
				? [
						h.p(
							[h.Class("px-3 pt-3 text-sm text-muted-foreground")],
							[
								"Showing the ",
								formatNumber(inputs.rows.length),
								" most recent sessions. Narrow the time range to see older ones",
							],
						),
					]
				: []),
		],
	)

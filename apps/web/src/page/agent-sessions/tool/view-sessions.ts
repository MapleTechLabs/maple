import { sessionLinkWindow, sessionRowId } from "@maple/agent-sessions"
import type { AiSessionListItem } from "@maple/domain/http"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { TONE_BORDER, TONE_FILL, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import { orderedSearch } from "../../../route/tanstack-search"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { skeletonList } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { vendorLabel } from "../kit/vendor"
import { relativeTime } from "../../kit/relative-time"
import { selectableRow } from "@maple/views/ui/selectable-row"
import type { Message } from "./message"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { hstack, vstack } from "@maple/views/ui/stack"

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
	return selectableRow(
		h,
		{
			isSelected: false,
			className:
				"flex w-full items-center gap-4 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
			attributes: [h.Key(session.sessionId)],
			// `{ ...sessionLinkWindow(session), tool, view }` in that order.
			href: `${hrefOf(AppRoute.AgentSession({ sessionId: session.sessionId, search: {} }))}${orderedSearch(
				[
					["t", sessionLinkWindow(session).t],
					["end", sessionLinkWindow(session).end],
					["tool", tool],
					["view", "trace"],
				],
			)}`,
		},
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
			vstack(h, { shrink: true, grow: true, as: "span", className: "w-0 gap-px" }, [
				typography(
					h,
					{
						size: "sm",
						tone: "foreground",
						weight: "medium",
						mono: true,
						truncate: true,
						className: "leading-4.5",
						attributes: [h.Title(session.sessionId)],
					},
					[sessionRowId(session.sessionId)],
				),
				typography(h, { size: "xs", tone: "muted", truncate: true }, [vendorLabel(session.vendorId)]),
			]),
			h.span(
				[
					h.Class(
						"hidden w-44 shrink-0 truncate text-xs text-muted-foreground @min-[720px]/panel:block",
					),
				],
				[
					Arr.join(
						Arr.filter([session.firstAgentName, ...session.serviceNames], (part) => part !== ""),
						" · ",
					),
				],
			),
			h.span(
				[h.Class("hidden w-56 shrink-0 items-baseline gap-2 @min-[560px]/panel:flex")],
				[
					h.span(
						[h.Class("font-mono text-ui font-semibold tabular-nums text-foreground")],
						[formatSessionDuration(session.durationMs)],
					),
					typography(h, { size: "xs", tone: "muted", truncate: true }, [
						countLabel(session.traceCount, "trace"),
						" ·",
						" ",
						countLabel(session.spanCount, "span"),
					]),
				],
			),
			h.span(
				[h.Class("hidden w-36 shrink-0 @min-[900px]/panel:flex")],
				hasErrors ? [errorCountPill(h, session.errorSpanCount)] : [],
			),
			relativeTime(h, {
				value: toEpochMs(session.startTime),
				variant: "orDate",
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
			hstack(h, { gap: "4", align: "center", justify: "between", wrap: true, className: "pb-3" }, [
				hstack(h, { gap: "2.5", align: "baseline", shrink: true, className: "font-mono" }, [
					typography(h, { size: "xs", tone: "foreground", weight: "medium" }, [
						"Sessions running ",
						inputs.tool,
					]),
					typography(h, { size: "2xs", tone: "subtle", numeric: true, className: "leading-3.5" }, [
						countLabel(inputs.rows.length, "session"),
					]),
				]),
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
			]),
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
							: Arr.map(inputs.rows, (session) =>
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

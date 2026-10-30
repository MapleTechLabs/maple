import { countLabel, EMPTY_VALUE, formatDuration } from "@maple/ui/lib/format"
import { httpStatusTone } from "@maple/ui/lib/http"
import { latencyLevel } from "@maple/ui/lib/latency-tone"
import { formatClock } from "@maple/ui/lib/replay-format"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import {
	toggleGroupConnectedStyles,
	toggleGroupHorizontalStyles,
	toggleGroupStyles,
} from "@maple/ui/styles/ui/toggle-group"
import { AsyncData } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { stableSlice } from "../../kit/stable-slice"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { httpSpanLabel } from "../../../ui/http-span-label"
import { icon, type IconName } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inlineCode } from "../../../ui/inline-code"
import { meter } from "../../../ui/meter"
import { skeleton } from "../../../ui/skeleton"
import { togglePrimitive } from "../../../ui/toggle"
import { MARKER_SOFT, MARKER_TEXT } from "../kit/replay-meta"
import { realOffsetFrom, timelineFrom } from "./derive"
import { Message } from "./message"
import type { EventFilter, EventRow, Model, RailTab, ReplayDetail, TraceSummary } from "./model"
import { sessionTab } from "./view-session"
import { noLinkedTraces } from "./view-timeline"

// The session rail: Events, Traces and Session tabs.
// TODO(rail-virtualize): the event list renders every row; long sessions should virtualize.
// TODO(event-legend): the kind legend's popover (hover or click on the info mark) is not ported.

type H = HtmlBuilder<Message>

const KIND_FILTERS = ["custom", "console", "network", "error"] as const

const FILTER_LABELS = {
	all: "All events",
	custom: "Product events",
	console: "Console messages",
	network: "Network requests",
	error: "Errors",
} satisfies Record<EventFilter, string>

// Event kinds are categories, so they take the timeline markers' chart hues; network has no marker.
const EVENT_KIND_VISUALS = {
	navigation: { icon: "PixelWindowIcon", tone: MARKER_TEXT.nav, selected: MARKER_SOFT.nav },
	click: { icon: "PixelCrosshairsIcon", tone: MARKER_TEXT.click, selected: MARKER_SOFT.click },
	network: { icon: "PixelNodesIcon", tone: "text-chart-5", selected: "bg-chart-5/15 text-chart-5" },
	custom: { icon: "PixelSparkleIcon", tone: "text-primary", selected: "bg-primary/15 text-primary" },
	console: {
		icon: "PixelBracketsCurlyIcon",
		tone: "text-muted-foreground",
		selected: "bg-muted text-foreground",
	},
	error: {
		icon: "PixelTriangleWarningIcon",
		tone: "text-severity-error",
		selected: "bg-severity-error/15 text-severity-error",
	},
} as const satisfies Record<string, { icon: IconName; tone: string; selected: string }>

const splitUrl = (url: string): { lead: string; trail: string } =>
	URL.canParse(url)
		? (({ pathname, search, host }) => ({ lead: `${pathname}${search}`, trail: host }))(new URL(url))
		: { lead: url, trail: "" }

const isFailedRequest = (ev: EventRow): boolean =>
	ev.type === "network" && (httpStatusTone(ev.netStatus) === "crit" || ev.netStatus === 0)

/** `eventVisual`: the row's glyph, tone and its two text lanes. */
const eventVisual = (ev: EventRow): { icon: IconName; tone: string; lead: string; trail: string } => {
	switch (ev.type) {
		case "navigation":
			return { ...EVENT_KIND_VISUALS.navigation, ...splitUrl(ev.url) }
		case "click":
			return {
				...EVENT_KIND_VISUALS.click,
				lead: ev.targetText || ev.targetSelector || "click",
				trail: ev.targetText ? ev.targetSelector : "",
			}
		case "network": {
			const { lead, trail } = splitUrl(ev.netUrl)
			return {
				...EVENT_KIND_VISUALS.network,
				tone: isFailedRequest(ev) ? EVENT_KIND_VISUALS.error.tone : EVENT_KIND_VISUALS.network.tone,
				lead: ev.netMethod ? `${ev.netMethod} ${lead}` : lead,
				trail,
			}
		}
		case "error":
			return { ...EVENT_KIND_VISUALS.error, lead: ev.message, trail: "" }
		case "custom":
			return { ...EVENT_KIND_VISUALS.custom, lead: ev.message, trail: "" }
		case "console": {
			const tone =
				ev.level === "error"
					? EVENT_KIND_VISUALS.error.tone
					: ev.level === "warn"
						? TONE_TEXT.warn
						: EVENT_KIND_VISUALS.console.tone
			return { ...EVENT_KIND_VISUALS.console, tone, lead: ev.message, trail: "" }
		}
		default:
			return { ...EVENT_KIND_VISUALS.console, lead: ev.message || ev.url, trail: "" }
	}
}

const statusTone = (status: number): string => {
	const tone = status === 0 ? "crit" : httpStatusTone(status)
	return tone === "neutral" ? "text-severity-info" : TONE_TEXT[tone]
}

const formatNetDuration = (ms: number): string => formatDuration(ms)

const isSlowRequest = (ms: number): boolean => {
	const level = latencyLevel(ms, "p95")
	return level === "slow" || level === "critical"
}

/** What the rail reads: no playhead, so a playback tick reuses the whole rail. */
const railOf = stableSlice((model: Model) => ({
	sessionId: model.sessionId,
	copies: model.copies,
	railTab: model.railTab,
	eventFilter: model.eventFilter,
	openEventIndex: model.openEventIndex,
	transcript: model.transcript,
	traceSummaries: model.traceSummaries,
	startTime: model.meta.startTime,
	inactiveIntervals: model.meta.inactiveIntervals,
	totalMs: model.player.totalMs,
	isSkippingIdle: model.player.isSkippingIdle,
}))
type RailView = ReturnType<typeof railOf>

/** `useClockAt`: a warehouse timestamp's clock offset in the recording. */
const clockAt = (model: RailView, timestamp: string): string => {
	const offset = realOffsetFrom(model.startTime, model.totalMs, timestamp)
	return offset === undefined ? EMPTY_VALUE : formatClock(timelineFrom(model).toDisplay(offset))
}

const filterButton = (
	h: H,
	config: Readonly<{
		filter: EventFilter
		isActive: boolean
		count: number
		tone: string
		selected: string
	}>,
	children: ReadonlyArray<Html>,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(Message.PickedEventFilter({ filter: config.filter })),
			h.AriaPressed(String(config.isActive)),
			h.AriaLabel(`${FILTER_LABELS[config.filter]} (${config.count})`),
			h.Class(
				cn(
					"flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors",
					config.isActive ? config.selected : cn(config.tone, "hover:bg-surface-sunken"),
					config.count === 0 && !config.isActive && "text-muted-foreground opacity-45",
				),
			),
		],
		[...children, h.span([h.Class("font-mono text-3xs tabular-nums")], [String(config.count)])],
	)

const filterBar = (h: H, model: RailView, events: ReadonlyArray<EventRow>): Html => {
	const countOf = (filter: EventFilter) =>
		filter === "all" ? events.length : events.filter((ev) => ev.type === filter).length
	return h.div(
		[
			h.Class(
				"sticky top-0 z-10 flex shrink-0 items-center gap-0.5 border-b border-border bg-card px-2 py-1",
			),
		],
		[
			filterButton(
				h,
				{
					filter: "all",
					isActive: model.eventFilter === "all",
					count: countOf("all"),
					tone: "text-muted-foreground",
					selected: "bg-muted text-foreground",
				},
				[h.span([h.Class("text-2xs font-medium")], ["All"])],
			),
			...KIND_FILTERS.map((filter) =>
				filterButton(
					h,
					{
						filter,
						isActive: model.eventFilter === filter,
						count: countOf(filter),
						tone: EVENT_KIND_VISUALS[filter].tone,
						selected: EVENT_KIND_VISUALS[filter].selected,
					},
					[
						icon(h, EVENT_KIND_VISUALS[filter].icon, {
							size: 14,
							attributes: [h.AriaHidden(true)],
						}),
					],
				),
			),
			iconButton(
				h,
				{
					label: "What the event icons mean",
					size: "icon-xs",
					hasTooltip: false,
					className:
						"ml-auto size-5 text-muted-foreground sm:size-5 data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
					attributes: [
						h.AriaHasPopup("dialog"),
						h.AriaExpanded(false),
						h.DataAttribute("base-ui-popover-trigger", ""),
					],
				},
				[icon(h, "CircleInfoIcon", { size: 14 })],
			),
		],
	)
}

const eventDetail = (h: H, ev: EventRow): Html => {
	const fullUrl = ev.type === "network" ? ev.netUrl : ev.url
	const props = ev.type === "custom" ? Object.entries(parseAttributes(ev.attributes)) : []
	return h.div(
		[h.Class("flex flex-col gap-1.5 px-3 pb-2.5 pl-[50px]")],
		[
			...(fullUrl
				? [h.span([h.Class("break-all text-2xs leading-4 text-muted-foreground")], [fullUrl])]
				: []),
			...(ev.type === "click" && ev.targetText && ev.targetSelector
				? [
						h.span(
							[h.Class("break-all text-2xs leading-4 text-muted-foreground")],
							[ev.targetSelector],
						),
					]
				: []),
			...(ev.type === "console"
				? [
						h.span(
							[
								h.Class(
									"whitespace-pre-wrap break-words text-2xs leading-4 text-foreground-soft",
								),
							],
							[ev.message],
						),
					]
				: []),
			...(ev.type === "error" && ev.errorStack
				? [
						h.span(
							[h.Class("whitespace-pre-wrap text-2xs leading-4 text-muted-foreground")],
							[ev.errorStack.split("\n").slice(0, 3).join("\n")],
						),
					]
				: []),
			...(props.length > 0
				? [
						h.span(
							[h.Class("flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-muted-foreground")],
							props.map(([key, value]) =>
								h.span(
									[h.Key(key)],
									[key, "=", h.span([h.Class("text-foreground-soft")], [value])],
								),
							),
						),
					]
				: []),
			...(ev.traceId
				? [
						h.a(
							[
								h.Href(
									hrefOf(
										AppRoute.Trace({ traceId: ev.traceId, search: { t: ev.timestamp } }),
									),
								),
								h.Class(
									"w-fit rounded-sm border border-input px-2 py-0.5 text-3xs text-muted-foreground hover:text-foreground",
								),
							],
							["Open trace"],
						),
					]
				: []),
		],
	)
}

const eventLine = (h: H, model: RailView, ev: EventRow, index: number, showNetworkBar: boolean): Html => {
	const visual = eventVisual(ev)
	const isError = ev.type === "error" || isFailedRequest(ev)
	const isOpen = model.openEventIndex === index
	return h.li(
		[h.Key(`${index}`), h.Class(cn("relative", isError && "bg-severity-error/5"))],
		[
			...(isError
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class("absolute inset-y-0 left-0 w-0.5 bg-severity-error"),
							],
							[],
						),
					]
				: []),
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedEvent({ index, timestamp: ev.timestamp })),
					h.AriaExpanded(isOpen),
					h.Class("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-sunken"),
					h.Title("Seek replay to this moment"),
				],
				[
					h.span(
						[h.Class("w-[30px] shrink-0 text-3xs tabular-nums text-muted-foreground")],
						[clockAt(model, ev.timestamp)],
					),
					h.span(
						[h.Class("grid size-4 shrink-0 place-items-center")],
						[icon(h, visual.icon, { size: 16, className: visual.tone })],
					),
					h.span(
						[h.Class("flex min-w-0 flex-1 items-baseline gap-1.5 truncate")],
						[
							h.span(
								[
									h.Class(
										cn("truncate", isError ? "text-severity-error" : "text-foreground"),
									),
								],
								[visual.lead],
							),
							...(visual.trail
								? [
										h.span(
											[h.Class("shrink-0 text-3xs text-muted-foreground")],
											[visual.trail],
										),
									]
								: []),
						],
					),
					h.span(
						[
							h.Class(
								"flex w-20 shrink-0 items-center justify-end gap-1.5 text-3xs tabular-nums",
							),
						],
						[
							...(ev.type === "network"
								? [
										h.span(
											[h.Class(cn("font-semibold", statusTone(ev.netStatus)))],
											[ev.netStatus ? String(ev.netStatus) : "ERR"],
										),
										h.span(
											[
												h.Class(
													cn(
														isError || isSlowRequest(ev.netDurationMs)
															? cn("font-semibold", TONE_TEXT.warn)
															: "text-muted-foreground",
														isError && TONE_TEXT.crit,
													),
												),
											],
											[formatNetDuration(ev.netDurationMs)],
										),
									]
								: ev.type === "console" && ev.level
									? [h.span([h.Class(visual.tone)], [ev.level])]
									: []),
						],
					),
				],
			),
			...(showNetworkBar && ev.type === "network"
				? [
						h.span(
							[h.Class("block px-3 pb-1.5 pl-[50px]")],
							[
								meter(h, {
									value: ev.netDurationMs,
									max: 3000,
									minVisible: 2,
									fillClassName: isError
										? TONE_FILL.crit
										: isSlowRequest(ev.netDurationMs)
											? TONE_FILL.warn
											: "bg-chart-1",
									className: "h-[3px] w-full bg-muted",
								}),
							],
						),
					]
				: []),
			...(isOpen ? [eventDetail(h, ev)] : []),
		],
	)
}

const eventsTab = (h: H, model: RailView): Html =>
	AsyncData.matchData(model.transcript.data, {
		onEmpty: () => skeleton(h, "m-3 min-h-0 flex-1 rounded-md"),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load session events", className: "flex-1 border-0" }),
		onData: (events) => {
			const filter = model.eventFilter
			const rows = filter === "all" ? events : events.filter((ev) => ev.type === filter)
			return h.div(
				[h.Class("flex min-h-0 flex-1 flex-col")],
				[
					filterBar(h, model, events),
					rows.length === 0
						? h.div(
								[
									h.Class(
										"grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground",
									),
								],
								[
									`No ${filter === "all" ? "events" : FILTER_LABELS[filter].toLowerCase()} in this session.`,
								],
							)
						: h.div(
								[h.Class("min-h-0 flex-1 overflow-y-auto")],
								[
									h.ul(
										[h.Class("relative divide-y divide-border font-mono text-xs")],
										rows.map((ev, index) =>
											eventLine(h, model, ev, index, filter === "network"),
										),
									),
								],
							),
				],
			)
		},
	})

const traceListRow = (h: H, model: RailView, summary: TraceSummary): Html => {
	const isError = summary.hasError > 0
	return h.li(
		[
			h.Key(summary.traceId),
			h.Class(
				cn(
					"relative flex flex-col gap-0.5 px-3 py-2.5 hover:bg-surface-sunken",
					isError && "bg-severity-error/5",
				),
			),
		],
		[
			...(isError
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class("absolute inset-y-0 left-0 w-0.5 bg-severity-error"),
							],
							[],
						),
					]
				: []),
			h.div(
				[h.Class("flex items-center gap-2.5")],
				[
					h.button(
						[
							h.Type("button"),
							h.OnClick(Message.RequestedSeekToTimestamp({ timestamp: summary.startTime })),
							h.Class(
								"w-10 shrink-0 text-left font-mono text-xs tabular-nums text-muted-foreground hover:text-foreground",
							),
						],
						[clockAt(model, summary.startTime)],
					),
					httpSpanLabel(h, {
						spanName: summary.rootSpanName || "trace",
						spanAttributes: parseAttributes(summary.rootSpanAttributes),
						spanKind: summary.rootSpanKind,
						className: "min-w-0 flex-1",
						textClassName: cn(
							"truncate text-xs font-medium",
							isError ? "text-severity-error" : "text-foreground",
						),
					}),
					h.span(
						[
							h.Class(
								cn(
									"shrink-0 font-mono text-2xs tabular-nums",
									isError ? "font-semibold text-severity-error" : "text-muted-foreground",
								),
							),
						],
						[formatNetDuration(Math.round(summary.durationMs))],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2 pl-[3.125rem]")],
				[
					h.span(
						[h.Class("min-w-0 truncate text-2xs text-muted-foreground")],
						[
							summary.rootServiceName,
							" · ",
							countLabel(summary.spanCount, "span"),
							isError ? " · error" : "",
						],
					),
					h.a(
						[
							h.Href(
								hrefOf(
									AppRoute.Trace({
										traceId: summary.traceId,
										search: { t: summary.startTime },
									}),
								),
							),
							h.Target("_blank"),
							h.Rel("noreferrer"),
							h.Class(
								"inline-flex shrink-0 items-center gap-1 text-2xs text-severity-debug underline-offset-2 hover:underline",
							),
						],
						["open", icon(h, "ExternalLinkIcon", { className: "size-3" })],
					),
				],
			),
		],
	)
}

const tracesTab = (h: H, model: RailView, traceIds: ReadonlyArray<string>): Html =>
	traceIds.length === 0
		? emptyMessage(
				h,
				{ className: "leading-relaxed" },
				noLinkedTraces(inlineCode(h, {}, ["@maple-dev/browser"])),
			)
		: AsyncData.matchData(model.traceSummaries.data, {
				onEmpty: () =>
					h.div([h.Class("space-y-2 p-4")], [skeleton(h, "h-4 w-2/3"), skeleton(h, "h-4 w-1/2")]),
				onFailure: (failure) =>
					errorState(h, {
						failure,
						variant: "inline",
						title: "Couldn't load correlated traces",
						className: "px-4",
					}),
				onData: (summaries) =>
					summaries.length === 0
						? emptyMessage(h, {}, [
								"Linked traces aren't available yet, they may still be ingesting.",
							])
						: h.ul(
								[h.Class("min-h-0 flex-1 divide-y divide-border overflow-y-auto")],
								summaries.map((summary) => traceListRow(h, model, summary)),
							),
			})

const railTabItem = (h: H, model: RailView, tab: RailTab, label: string, count?: number): Html =>
	togglePrimitive(
		h,
		{
			isPressed: model.railTab === tab,
			onClick: Message.PickedRailTab({ tab }),
			className: cn(
				toggleVariants({ size: "sm", variant: "default" }),
				"h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground data-pressed:bg-muted data-pressed:text-foreground sm:h-7 sm:text-xs",
			),
			slot: "toggle",
			attributes: [
				h.AriaDisabled(false),
				h.DataAttribute("size", "sm"),
				h.DataAttribute("variant", "default"),
			],
		},
		[
			label,
			...(count === undefined
				? []
				: [
						h.span(
							[h.Class("font-mono text-3xs tabular-nums text-muted-foreground")],
							[String(count)],
						),
					]),
		],
	)

const railSlot = createLazy()

/** The right rail: Events / Traces / Session. */
export const sessionRail = (h: H, model: Model, session: ReplayDetail): Html =>
	railSlot(railView, [h, railOf(model), session])

const railView = (h: H, model: RailView, session: ReplayDetail): Html =>
	h.section(
		[
			h.Class(
				cn(
					"flex min-h-0 flex-col overflow-hidden border-border bg-card",
					"shrink-0 border-t max-lg:h-96 lg:w-84 lg:border-t-0 lg:border-l",
				),
			),
		],
		[
			h.div(
				[h.Class("flex shrink-0 items-center border-b border-border px-2 py-1.5")],
				[
					h.div(
						[
							h.Role("group"),
							h.AriaLabel("Rail section"),
							h.Class(
								cn(
									toggleGroupStyles,
									toggleGroupHorizontalStyles,
									toggleGroupConnectedStyles,
								),
							),
							h.DataAttribute("orientation", "horizontal"),
							h.DataAttribute("size", "sm"),
							h.DataAttribute("slot", "toggle-group"),
							h.DataAttribute("variant", "default"),
						],
						[
							railTabItem(h, model, "events", "Events"),
							railTabItem(h, model, "traces", "Traces", session.traceIds.length),
							railTabItem(h, model, "session", "Session"),
						],
					),
				],
			),
			model.railTab === "events"
				? eventsTab(h, model)
				: model.railTab === "traces"
					? tracesTab(h, model, session.traceIds)
					: sessionTab(h, model, session),
		],
	)

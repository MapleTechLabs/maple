import { formatDuration } from "@maple/ui/lib/format"
import { formatClock } from "@maple/ui/lib/replay-format"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { cn } from "@maple/ui/lib/utils"
import {
	parseChTimestampMs,
	spanDisplayRange,
	type Timeline,
} from "../../../components/replays/replay-timeline"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { httpSpanLabel } from "../../../ui/http-span-label"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { stableSlice } from "../../kit/stable-slice"
import { MARKER_LABELS, MARKER_STYLES } from "../kit/replay-meta"
import { timelineFrom } from "./derive"
import { Message } from "./message"
import type { Model, SpanRow, TraceSummary } from "./model"
import { idleBandsTrack, markersTrack, type Playhead, playheadOf } from "./view-player"

// The replay editor timeline.
// TODO(tooltip): the trace and span bars' hover tooltips.

type H = HtmlBuilder<Message>

const LANE_GUTTER = "w-28 sm:w-36"
const KINDS = ["click", "input", "scroll", "nav"] as const

const pct = (ms: number, totalMs: number): number =>
	totalMs <= 0 ? 0 : Math.min(100, Math.max(0, (ms / totalMs) * 100))

/** `MarkerLegend`. */
export const markerLegend = (h: H): Html =>
	h.ul(
		[
			h.Class("flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs text-muted-foreground"),
			h.AriaLabel("Activity marker legend"),
		],
		KINDS.map((kind) =>
			h.li(
				[h.Class("flex items-center gap-1.5")],
				[
					h.span(
						[
							h.Class(cn("size-1.5 rounded-full ring-1 ring-card", MARKER_STYLES[kind])),
							h.AriaHidden(true),
						],
						[],
					),
					MARKER_LABELS[kind],
				],
			),
		),
	)

const timeRuler = (h: H, totalMs: number): Html => {
	const ticks = Array.from({ length: 7 }, (_, i) => (totalMs * i) / 6)
	return h.div(
		[h.Class("flex items-stretch border-b border-border-subtle bg-surface-faint")],
		[
			h.div([h.Class(cn(LANE_GUTTER, "shrink-0 border-r border-border-subtle"))], []),
			h.div(
				[h.Class("relative h-5 flex-1")],
				ticks.map((ms, i) =>
					h.span(
						[
							h.Class(
								cn(
									"absolute top-0 -translate-x-1/2 px-1 font-mono text-3xs tabular-nums text-muted-foreground",
									i === 0 && "translate-x-0",
									i === ticks.length - 1 && "-translate-x-full",
									i !== 0 && i !== 3 && i !== ticks.length - 1 && "max-sm:hidden",
								),
							),
							h.Style({ left: `${pct(ms, totalMs)}%` }),
						],
						[formatClock(ms)],
					),
				),
			),
		],
	)
}

const activityTrack = (h: H, model: Model, playhead: Playhead): Html =>
	h.div(
		[h.Class("flex items-stretch border-b border-border-subtle")],
		[
			activityGutterSlot(activityGutter, [h]),
			h.div(
				[h.Class("relative h-9 flex-1")],
				[
					h.div(
						[
							h.Class(
								"absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted",
							),
						],
						[
							idleBandsTrack(h, model, "timeline"),
							h.div(
								[
									h.Class("relative h-full rounded-full bg-primary"),
									h.Style({ width: `${pct(playhead.currentMs, playhead.totalMs)}%` }),
								],
								[],
							),
						],
					),
					markersTrack(h, model, "timeline"),
				],
			),
		],
	)

const activityGutter = (h: H): Html =>
	h.div(
		[
			h.Class(
				cn(
					LANE_GUTTER,
					"flex shrink-0 items-center gap-1.5 border-r border-border-subtle px-3 py-2 text-xs font-medium text-muted-foreground",
				),
			),
		],
		[icon(h, "CursorIcon", { className: "size-3.5" }), "Activity"],
	)

const scrubSurface = (h: H, playhead: Playhead): Html =>
	h.div(
		[
			h.Role("slider"),
			h.AriaLabel("Seek"),
			h.AriaValuemin(0),
			h.AriaValuemax(Math.round(playhead.totalMs)),
			h.AriaValuenow(Math.round(playhead.currentMs)),
			h.Tabindex(0),
			h.DataAttribute("replay-scrub", "timeline"),
			h.OnPointerDown((_type, _button, _screenX, _screenY, _time, clientX) =>
				Option.some(Message.PressedScrubber({ surface: "timeline", clientX })),
			),
			h.Class("absolute inset-y-0 right-0 left-28 cursor-pointer touch-none select-none sm:left-36"),
		],
		[],
	)

/** The text both empty traces states share (the track and the rail's tab). */
export const noLinkedTraces = (code: Html): ReadonlyArray<Html | string> => [
	"No backend traces were linked to this session. Correlation populates automatically when the page is instrumented with ",
	code,
	" ",
	"tracing.",
]

const tracesHeader = (h: H, count: number | null): Html =>
	eyebrow(
		h,
		{
			as: "div",
			variant: "label",
			className: "flex items-center gap-2 border-b border-border-subtle bg-surface-faint px-3 py-1.5",
		},
		[
			icon(h, "PulseIcon", { className: "size-3.5" }),
			"Traces",
			...(count !== null && count > 0
				? [
						badge(
							h,
							{
								variant: "muted",
								pill: true,
								size: "xs",
								className: "bg-primary-a2 text-primary tabular-nums",
							},
							[String(count)],
						),
					]
				: []),
		],
	)

/** What the traces track reads: its rows only move when the recording or the traces change. */
const tracesOf = stableSlice((model: Model) => ({
	traceSummaries: model.traceSummaries,
	spans: model.spans,
	expandedTraces: model.expandedTraces,
	startTime: model.meta.startTime,
	inactiveIntervals: model.meta.inactiveIntervals,
	totalMs: model.player.totalMs,
	isSkippingIdle: model.player.isSkippingIdle,
}))
type TracesView = ReturnType<typeof tracesOf>

type SeekFrame = Readonly<{ view: TracesView; timeline: Timeline }>

const rangeOf = (frame: SeekFrame, startTime: string, durationMs: number) =>
	spanDisplayRange({
		spanStartIso: startTime,
		durationMs,
		recordingStartEpochMs: frame.view.startTime,
		realTotalMs: frame.view.totalMs,
		timeline: frame.timeline,
	})

const spanRowItem = (h: H, frame: SeekFrame, span: SpanRow): Html => {
	const range = rangeOf(frame, span.startTime, span.durationMs)
	const leftPct = pct(range.displayStartMs, frame.timeline.activeTotalMs)
	const widthPct = Math.max(0.4, pct(range.displayEndMs, frame.timeline.activeTotalMs) - leftPct)
	return h.div(
		[h.Key(span.spanId), h.Class("flex items-stretch")],
		[
			h.div(
				[
					h.Class(
						cn(LANE_GUTTER, "shrink-0 truncate border-r border-border-subtle px-2 py-1 pl-6"),
					),
					h.Title(`${span.serviceName} · ${span.spanName}`),
				],
				[
					httpSpanLabel(h, {
						spanName: span.spanName,
						spanAttributes: span.spanAttributes,
						spanKind: span.spanKind,
						className: "text-3xs",
						textClassName: "text-3xs text-muted-foreground",
					}),
				],
			),
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.RequestedSeek({ displayMs: range.displayStartMs })),
					h.Class("relative h-5 flex-1 cursor-pointer"),
				],
				[
					h.span(
						[
							h.Class(
								cn(
									"absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm transition-[filter] hover:brightness-110 active:brightness-110",
									span.statusCode === "Error" ? "bg-severity-error" : "bg-primary/70",
									range.outOfRange && "opacity-50",
								),
							),
							h.Style({ left: `${leftPct}%`, width: `${widthPct}%`, "min-width": "4px" }),
						],
						[],
					),
				],
			),
		],
	)
}

const spanLane = (h: H, frame: SeekFrame, traceId: string): Html => {
	const data = frame.view.spans[traceId] ?? AsyncData.Loading()
	return AsyncData.matchData(data, {
		onEmpty: () => h.div([h.Class("bg-surface-faint px-3 py-2")], [skeleton(h, "h-3 w-1/2")]),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				variant: "inline",
				title: "Couldn't load spans for this trace",
				className: "bg-surface-faint px-3 py-2",
			}),
		onData: (spans) =>
			spans.length === 0
				? emptyMessage(h, { className: "bg-surface-faint py-2 text-2xs" }, [
						"No spans found for this trace.",
					])
				: h.div(
						[h.Class("max-h-56 space-y-px overflow-y-auto bg-surface-faint py-1")],
						[...spans]
							.sort((a, b) => parseChTimestampMs(a.startTime) - parseChTimestampMs(b.startTime))
							.map((span) => spanRowItem(h, frame, span)),
					),
	})
}

const traceRow = (h: H, frame: SeekFrame, summary: TraceSummary): Html => {
	const isExpanded = frame.view.expandedTraces.includes(summary.traceId)
	const range = rangeOf(frame, summary.startTime, summary.durationMs)
	const isError = summary.hasError > 0
	const leftPct = pct(range.displayStartMs, frame.timeline.activeTotalMs)
	const widthPct = Math.max(0.6, pct(range.displayEndMs, frame.timeline.activeTotalMs) - leftPct)
	return h.li(
		[h.Key(summary.traceId), h.Class("border-b border-border-subtle last:border-b-0")],
		[
			h.div(
				[h.Class("flex items-stretch")],
				[
					h.div(
						[
							h.Class(
								cn(
									LANE_GUTTER,
									"flex shrink-0 items-center gap-1.5 border-r border-border-subtle pr-2 pl-2 text-xs",
								),
							),
						],
						[
							iconButton(
								h,
								{
									label: isExpanded ? "Hide spans" : `Show ${summary.spanCount} spans`,
									size: "icon-xs",
									className: "size-5 text-muted-foreground sm:size-5",
									attributes: [
										h.AriaExpanded(isExpanded),
										h.OnClick(
											Message.ToggledTraceSpans({
												traceId: summary.traceId,
												startTime: summary.startTime,
											}),
										),
									],
								},
								[icon(h, isExpanded ? "ChevronDownIcon" : "ChevronRightIcon")],
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
										"group/trace flex min-w-0 flex-1 items-center rounded-sm px-1 py-1.5 text-left hover:bg-surface-sunken active:bg-surface-sunken",
									),
								],
								[
									h.span(
										[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
										[
											h.span(
												[
													h.Class(
														"flex items-center gap-1 truncate font-medium leading-tight text-foreground",
													),
												],
												[
													httpSpanLabel(h, {
														spanName: summary.rootSpanName || "trace",
														spanAttributes: parseAttributes(
															summary.rootSpanAttributes,
														),
														spanKind: summary.rootSpanKind,
														className: "min-w-0",
														textClassName: "truncate",
													}),
													icon(h, "ExternalLinkIcon", {
														className:
															"size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/trace:opacity-100",
													}),
												],
											),
											h.span(
												[
													h.Class(
														"block truncate font-mono text-3xs leading-tight text-muted-foreground",
													),
												],
												[summary.rootServiceName],
											),
										],
									),
								],
							),
						],
					),
					h.button(
						[
							h.Type("button"),
							h.OnClick(Message.RequestedSeek({ displayMs: range.displayStartMs })),
							h.Class("relative h-11 flex-1 cursor-pointer"),
						],
						[
							h.span(
								[
									h.Class(
										cn(
											"absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded-sm px-1.5 text-3xs font-medium text-white ring-1 ring-inset transition-[filter] hover:brightness-110 active:brightness-110",
											isError
												? "bg-severity-error ring-severity-error-a4"
												: "bg-primary ring-primary-a4",
											range.outOfRange &&
												"opacity-60 outline-1 outline-dashed outline-white/70 -outline-offset-1",
										),
									),
									h.Style({
										left: `${leftPct}%`,
										width: `${widthPct}%`,
										"min-width": "6px",
									}),
								],
								[h.span([h.Class("truncate")], [formatDuration(summary.durationMs)])],
							),
						],
					),
				],
			),
			...(isExpanded ? [spanLane(h, frame, summary.traceId)] : []),
		],
	)
}

const tracesTrack = (h: H, view: TracesView, traceIds: ReadonlyArray<string>): Html => {
	const frame: SeekFrame = { view, timeline: timelineFrom(view) }
	if (traceIds.length === 0)
		return h.div(
			[],
			[
				tracesHeader(h, 0),
				emptyMessage(
					h,
					{ className: "leading-relaxed" },
					noLinkedTraces(h.span([h.Class("font-mono")], ["@maple-dev/browser"])),
				),
			],
		)
	return h.div(
		[],
		AsyncData.matchData(view.traceSummaries.data, {
			onEmpty: () => [
				tracesHeader(h, null),
				h.div([h.Class("space-y-2 px-3 py-3")], [skeleton(h, "h-4 w-2/3"), skeleton(h, "h-4 w-1/2")]),
			],
			onFailure: (failure) => [
				tracesHeader(h, null),
				errorState(h, {
					failure,
					variant: "inline",
					title: "Couldn't load correlated traces",
					className: "px-3",
				}),
			],
			onData: (summaries) => [
				tracesHeader(h, summaries.length),
				summaries.length === 0
					? emptyMessage(h, {}, [
							"Linked traces aren't available yet, they may still be ingesting.",
						])
					: h.ul(
							[h.Class("max-h-72 overflow-y-auto")],
							summaries.map((summary) => traceRow(h, frame, summary)),
						),
			],
		}),
	)
}

const headerSlot = createLazy()
const activityGutterSlot = createLazy()
const rulerSlot = createLazy()
const tracesSlot = createLazy()

const timelineHeader = (h: H): Html =>
	h.div(
		[
			h.Class(
				"flex items-center justify-between gap-3 border-b border-border bg-surface-sunken px-3 py-2",
			),
		],
		[eyebrow(h, { variant: "label" }, ["Timeline"]), markerLegend(h)],
	)

/** The timeline panel: legend, ruler, activity, traces, one playhead over them. A tick rebuilds the playhead only. */
export const replayTimeline = (h: H, model: Model, traceIds: ReadonlyArray<string>): Html => {
	const playhead = playheadOf(model)
	return panel(h, { className: "shadow-raised" }, [
		headerSlot(timelineHeader, [h]),
		h.div(
			[h.Class("relative")],
			[
				h.div(
					[h.Class("relative")],
					[
						rulerSlot(timeRuler, [h, playhead.totalMs]),
						activityTrack(h, model, playhead),
						scrubSurface(h, playhead),
					],
				),
				tracesSlot(tracesTrack, [h, tracesOf(model), traceIds]),
				playheadLine(h, playhead),
			],
		),
	])
}

const playheadLine = (h: H, playhead: Playhead): Html =>
	h.div(
		[h.Class("pointer-events-none absolute inset-y-0 right-0 left-28 sm:left-36")],
		[
			h.div(
				[
					h.Class("absolute inset-y-0 w-px bg-primary/80"),
					h.Style({ left: `${pct(playhead.currentMs, playhead.totalMs)}%` }),
				],
				[
					h.div(
						[
							h.Class(
								"absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary shadow-raised",
							),
						],
						[],
					),
				],
			),
		],
	)

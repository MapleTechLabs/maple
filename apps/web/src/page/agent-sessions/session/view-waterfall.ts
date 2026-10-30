import type { AiSessionSpan } from "@maple/domain/http"
import {
	type AiSpanCategory,
	classifyAiSpan,
	countTurnTokens,
	isLlmCall,
	type SessionTokenTotals,
	type SessionTurn,
	spanEndMs,
	spanFailed,
	spanModel,
	spanStartMs,
	spanTokenBuckets,
	spanTtftMs,
} from "@maple/agent-sessions"
import { type AxisTick, buildSessionAxis, type SessionAxis } from "../../../lib/agent-sessions/session-axis"
import { isDelegation } from "../../../lib/agent-sessions/span-filters"
import { shortId } from "@maple/ui/lib/ids"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { segmentedBar } from "../../../ui/meter"
import { type DetectedModel, detectLookup } from "../kit/detected-models"
import { modelLabel } from "../kit/model-label"
import { virtualAttributes, virtualize } from "../kit/virtualize"
import { TOKEN_BUCKETS } from "../kit/token-buckets"
import type { SessionData } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { CATEGORY_FILL, CATEGORY_ICON, CATEGORY_TEXT } from "./span-visuals"
import { failedBadge } from "./view-kit"
import { rowHeight, spanHeading, spanTarget, type WaterfallRow, waterfallRowsOf } from "./waterfall-rows"

// The session waterfall: turns, spans and idle gaps on one axis.

type H = HtmlBuilder<Message>

const MAX_INDENT_DEPTH = 6
const INDENT_PX = 14
const AXIS_EDGE_FRACTION = 0.9

const COL_SPAN = "w-[398px] max-w-[46%] min-w-0 shrink-0 flex items-center gap-1.5"
const COL_MODEL = "hidden w-36 shrink-0 truncate px-2 text-muted-foreground @3xl:block"
const COL_TOKENS =
	"hidden w-32 shrink-0 truncate px-2 text-right tabular-nums text-muted-foreground @3xl:block"
const COL_TOKENS_SPLIT = "hidden w-32 shrink-0 items-center gap-1.5 px-2 @3xl:flex"
const COL_AXIS = "relative ml-3 min-w-0 flex-1 self-stretch"
const COL_DUR = "w-[60px] shrink-0 pl-2 text-right tabular-nums"

const tickAnchor = (index: number, ticks: ReadonlyArray<AxisTick>): string => {
	if (index === 0) return ""
	const atEnd = index === ticks.length - 1 && (ticks[index]?.fraction ?? 0) > AXIS_EDGE_FRACTION
	return atEnd ? "-translate-x-full" : "-translate-x-1/2"
}

const axisGrid = (h: H, ticks: ReadonlyArray<AxisTick>): ReadonlyArray<Html> =>
	ticks.map((tick) =>
		h.span(
			[
				h.Key(String(tick.fraction)),
				h.AriaHidden(true),
				h.Class("absolute inset-y-0 w-px bg-border-subtle"),
				h.Style({ left: `${tick.fraction * 100}%` }),
			],
			[],
		),
	)

const tokenCell = (h: H, tokens: SessionTokenTotals | undefined, locale: string, isErrored = false): Html => {
	const drawn = tokens === undefined ? [] : TOKEN_BUCKETS.filter((bucket) => tokens[bucket.key] > 0)
	if (tokens === undefined || tokens.total === 0 || drawn.length === 0)
		return h.span([h.Class(cn(COL_TOKENS, isErrored && "text-severity-error"))], [EMPTY_VALUE])
	const title = [
		`${formatNumber(tokens.total)} tokens`,
		...drawn.map((bucket) => `${bucket.label}: ${tokens[bucket.key].toLocaleString(locale)}`),
	].join("\n")
	return h.span(
		[h.Class(COL_TOKENS_SPLIT), h.Title(title)],
		[
			segmentedBar(h, {
				segments: drawn.map((bucket) => ({
					key: bucket.key,
					value: tokens[bucket.key],
					className: bucket.fill,
				})),
				total: tokens.total,
				className: "flex-1 gap-px rounded-xs bg-muted",
			}),
			h.span(
				[
					h.Class(
						cn("shrink-0 tabular-nums text-muted-foreground", isErrored && "text-severity-error"),
					),
				],
				[formatNumber(tokens.total)],
			),
		],
	)
}

const traceLink = (h: H, traceId: string, timestamp: string): Html =>
	h.a(
		[
			h.Class(
				cn(
					"shrink-0 cursor-pointer rounded-xs font-mono hover:text-foreground",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
			h.Href(hrefOf(AppRoute.Trace({ traceId, search: { t: timestamp } }))),
		],
		["Trace ", shortId(traceId, "trace")],
	)

const turnToggle = (h: H, row: Extract<WaterfallRow, { kind: "turn" }>, isCollapsed: boolean): Html =>
	h.button(
		[
			h.AriaExpanded(!isCollapsed),
			h.Class(
				cn(
					"flex min-w-0 flex-1 items-center gap-1.5 rounded-xs text-left",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
			h.Type("button"),
			h.OnClick(Message.ToggledTurn({ turnId: row.turn.id })),
		],
		[
			icon(h, isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon", {
				size: 12,
				className: "shrink-0 text-muted-foreground",
			}),
			eyebrow(h, { className: "shrink-0 text-primary" }, [
				`${row.turn.anchorKind === "trace" ? "Segment" : "Turn"} ${row.turn.index}`,
			]),
			h.span(
				[h.Class("min-w-0 truncate text-muted-foreground")],
				[
					row.turn.label === undefined
						? h.span([h.Class("italic")], ["no captured message"])
						: row.turn.label,
				],
			),
			...(row.turn.failed ? [failedBadge(h)] : []),
			...(isCollapsed
				? [
						badge(h, { variant: "muted", pill: true, size: "xs", className: "tabular-nums" }, [
							String(row.visibleCount),
							" spans",
						]),
					]
				: []),
		],
	)

const turnHeader = (
	h: H,
	row: Extract<WaterfallRow, { kind: "turn" }>,
	turns: ReadonlyArray<SessionTurn>,
	axis: SessionAxis,
	isCollapsed: boolean,
	locale: string,
): Html => {
	const { turn } = row
	const left = axis.fraction(turn.startMs) * 100
	const width = Math.max(0.4, (axis.fraction(turn.endMs) - axis.fraction(turn.startMs)) * 100)
	const traceId = turn.traceIds[0]
	return h.div(
		[
			h.Class(
				"flex h-full w-full items-center rounded-md bg-card px-2.5 text-left text-xs hover:bg-surface-sunken",
			),
		],
		[
			h.span(
				[h.Class(COL_SPAN)],
				[
					turnToggle(h, row, isCollapsed),
					...(traceId === undefined
						? []
						: [
								eyebrow(h, { className: "flex shrink-0 items-center gap-1" }, [
									traceLink(h, traceId, turn.anchor.timestamp),
									...(turn.traceIds.length > 1
										? [h.span([], ["+", String(turn.traceIds.length - 1)])]
										: []),
								]),
							]),
				],
			),
			h.span([h.Class(COL_MODEL)], [turn.agentName ?? EMPTY_VALUE]),
			tokenCell(h, countTurnTokens(turn, turns), locale),
			h.span(
				[h.Class(COL_AXIS)],
				[
					...axisGrid(h, axis.ticks),
					h.span(
						[
							h.Class("absolute inset-y-0 my-auto h-1.5 rounded-xs bg-muted"),
							h.Style({ left: `${left}%`, width: `${width}%` }),
						],
						[],
					),
				],
			),
			h.span([h.Class(cn(COL_DUR, "text-muted-foreground"))], [formatDuration(turn.durationMs)]),
		],
	)
}

const spanBar = (
	h: H,
	span: AiSessionSpan,
	axis: SessionAxis,
	category: AiSpanCategory,
	isErrored: boolean,
): Html => {
	const startMs = spanStartMs(span)
	const left = axis.fraction(startMs) * 100
	const width = Math.max(0.35, (axis.fraction(spanEndMs(span)) - axis.fraction(startMs)) * 100)
	const ttftMs = spanTtftMs(span)
	const ttftShare = ttftMs === undefined ? 0 : (ttftMs / span.durationMs) * 100
	const isContainer = category === "agent" && !isErrored
	return h.span(
		[
			h.Class("absolute inset-y-0 my-auto h-1.5 overflow-hidden rounded-xs"),
			h.Style({ left: `${left}%`, width: `${width}%` }),
		],
		ttftMs !== undefined && !isErrored
			? [
					h.span(
						[
							h.Class("absolute inset-y-0 left-0 bg-chart-2/45"),
							h.Style({ width: `${ttftShare}%` }),
						],
						[],
					),
					h.span(
						[
							h.Class("absolute inset-y-0 right-0 bg-chart-2"),
							h.Style({ width: `${100 - ttftShare}%` }),
						],
						[],
					),
				]
			: [
					h.span(
						[
							h.Class(
								cn(
									"absolute inset-0",
									isErrored ? "bg-severity-error" : CATEGORY_FILL[category],
									isContainer && "opacity-35",
								),
							),
						],
						[],
					),
				],
	)
}

type SpanRowState = Readonly<{ isSelected: boolean; isRevealed: boolean; isFocused: boolean; locale: string }>

const spanCell = (
	h: H,
	span: AiSessionSpan,
	depth: number,
	category: AiSpanCategory,
	isDelegated: boolean,
): Html => {
	const isErrored = spanFailed(span)
	const heading = spanHeading(span, category)
	return h.span(
		[
			h.Class(COL_SPAN),
			h.Style({ "padding-left": `${Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX}px` }),
		],
		[
			icon(h, isErrored ? "CircleXmarkIcon" : CATEGORY_ICON[category], {
				size: 14,
				className: cn("shrink-0", isErrored ? "text-severity-error" : CATEGORY_TEXT[category]),
				attributes: [h.AriaHidden(true)],
			}),
			...(heading.operation === undefined
				? []
				: [h.span([h.Class("shrink-0 text-foreground-subtle")], [heading.operation])]),
			...(heading.subject === undefined
				? []
				: [h.span([h.Class("max-w-[60%] shrink-0 truncate font-medium")], [heading.subject])]),
			...(span.statusMessage === ""
				? []
				: [h.span([h.Class("min-w-0 truncate text-muted-foreground")], [span.statusMessage])]),
			...(isErrored ? [failedBadge(h, span.genAi.errorType ?? "Error")] : []),
			...(isDelegated ? [badge(h, { variant: "tag" }, ["Subagent"])] : []),
		],
	)
}

const spanRow = (
	h: H,
	row: Extract<WaterfallRow, { kind: "span" }>,
	axis: SessionAxis,
	spansById: ReadonlyMap<string, AiSessionSpan>,
	detect: (model: string) => DetectedModel,
	state: SpanRowState,
): Html => {
	const { span } = row
	const category = classifyAiSpan(span)
	const isErrored = spanFailed(span)
	const target = spanTarget(span, category)
	const model = category === "tool" ? undefined : spanModel(span)
	return h.button(
		[
			...(state.isSelected ? [h.AriaCurrent("true")] : []),
			h.AriaExpanded(state.isSelected),
			h.AriaHasPopup("dialog"),
			h.Class(
				cn(
					"flex h-full w-full cursor-pointer items-center px-2.5 text-left text-xs hover:bg-surface-sunken",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					isErrored && "bg-severity-error/6",
					state.isFocused && "bg-accent/60",
					rowSelectedClass(state.isSelected || state.isRevealed),
					state.isRevealed && "bg-primary/12",
				),
			),
			...(state.isRevealed ? [h.DataAttribute("revealed", "true")] : []),
			h.DataAttribute("span-row", span.spanId),
			h.Type("button"),
			h.OnClick(Message.ClickedWaterfallSpan({ spanId: span.spanId })),
		],
		[
			spanCell(h, span, row.depth, category, isDelegation(span, spansById)),
			h.span(
				[
					h.Class(cn(COL_MODEL, isErrored && "text-severity-error")),
					...(model === undefined && target !== undefined ? [h.Title(target)] : []),
				],
				[
					model === undefined
						? (target ?? EMPTY_VALUE)
						: modelLabel(h, { detected: detect(model), size: 12, title: target }),
				],
			),
			tokenCell(h, isLlmCall(span) ? spanTokenBuckets(span) : undefined, state.locale, isErrored),
			h.span(
				[h.Class(COL_AXIS)],
				[...axisGrid(h, axis.ticks), spanBar(h, span, axis, category, isErrored)],
			),
			h.span([h.Class(cn(COL_DUR, "text-muted-foreground"))], [formatDuration(span.durationMs)]),
		],
	)
}

const gapRow = (h: H, durationMs: number): Html =>
	h.div(
		[h.Class("flex h-full items-center gap-3 pr-2.5 pl-20 text-2xs text-muted-foreground")],
		[
			h.span([h.Class("shrink-0")], ["idle ", formatSessionDuration(durationMs)]),
			h.span([h.AriaHidden(true), h.Class("h-px flex-1 bg-border")], []),
		],
	)

const ruler = (
	h: H,
	axis: SessionAxis,
	gapStarts: ReadonlyArray<Readonly<{ id: string; startMs: number }>>,
): Html =>
	h.div(
		[h.Class("sticky top-[var(--session-controls-height,0px)] z-10 bg-background")],
		[
			eyebrow(
				h,
				{
					variant: "label",
					as: "div",
					className: "flex h-7 items-center border-border border-b px-2.5",
				},
				[
					h.span([h.Class(COL_SPAN)], ["Span"]),
					h.span([h.Class(COL_MODEL)], ["Model / target"]),
					h.span([h.Class(COL_TOKENS)], ["Tokens"]),
					h.span(
						[h.Class(cn(COL_AXIS, "flex items-center"))],
						[
							...axis.ticks.map((tick, index) =>
								h.span(
									[
										h.Key(String(tick.fraction)),
										h.Class(
											cn(
												"absolute whitespace-nowrap normal-case tabular-nums",
												tickAnchor(index, axis.ticks),
											),
										),
										h.Style({ left: `${tick.fraction * 100}%` }),
									],
									[tick.label],
								),
							),
							...gapStarts.map((gap) =>
								h.span(
									[
										h.Key(gap.id),
										h.AriaHidden(true),
										h.Class("absolute inset-y-0 border-border border-l-2 border-dashed"),
										h.Style({ left: `${axis.fraction(gap.startMs) * 100}%` }),
									],
									[],
								),
							),
						],
					),
					h.span([h.Class(COL_DUR)], ["Dur"]),
				],
			),
			...(axis.removedGapCount > 0
				? [
						h.p(
							[h.Class("border-border border-b px-2.5 py-1 text-2xs text-muted-foreground")],
							[
								// One text node per expression: the split shifts the line's kerning.
								"Axis shows active time. ",
								formatSessionDuration(axis.removedMs),
								" of idle removed across",
								" ",
								String(axis.removedGapCount),
								" gap",
								...(axis.removedGapCount === 1 ? [] : ["s"]),
								".",
							],
						),
					]
				: []),
		],
	)

export const waterfall = (h: H, model: Model, data: SessionData): Html => {
	const { turns, summary } = data
	const detect = detectLookup(model.detections)
	const spans = turns.flatMap((turn) => turn.spans)
	const spansById = new Map(spans.map((span) => [span.spanId, span]))
	const gaps = model.options.collapseIdle ? summary.idleGaps : []
	const axis = buildSessionAxis({ startMs: summary.startMs, endMs: summary.endMs, collapsedGaps: gaps })
	const rows = waterfallRowsOf(model, data)
	const rowView = (row: WaterfallRow): Html => {
		if (row.kind === "turn")
			return turnHeader(h, row, turns, axis, model.collapsedTurns.includes(row.turn.id), model.locale)
		if (row.kind === "gap") return gapRow(h, row.gap.durationMs)
		return spanRow(h, row, axis, spansById, detect, {
			isSelected: model.search.span === row.span.spanId,
			isRevealed: model.revealedSpanId === row.span.spanId,
			isFocused: model.focusedSpanId === row.span.spanId,
			locale: model.locale,
		})
	}
	const { items, scrollMargin, totalSize } = model.waterfallWindow
	return h.div(
		[h.Class("@container flex grow flex-col")],
		[
			ruler(h, axis, gaps),
			h.div(
				[
					...virtualAttributes(
						h,
						rows.map((row) => row.key),
						rows.map(rowHeight),
						model.scroll ?? undefined,
					),
					h.OnMount(VirtualizeWaterfall()),
				],
				[
					rows.length === 0
						? emptyMessage(h, {}, ["No spans match this filter."])
						: h.div(
								[h.Class("relative w-full"), h.Style({ height: `${totalSize}px` })],
								items.flatMap((item) => {
									const row = rows[item.index]
									if (row === undefined) return []
									return [
										h.div(
											[
												h.Key(row.key),
												h.DataAttribute("index", String(item.index)),
												h.Class("absolute inset-x-0 top-0"),
												h.Style({
													height: `${item.end - item.start}px`,
													transform: `translateY(${item.start - scrollMargin}px)`,
												}),
											],
											[rowView(row)],
										),
									]
								}),
							),
				],
			),
		],
	)
}

/** `useVirtualizer` over the page scroller: rows are their estimates, never measured. */
const VirtualizeWaterfall = Mount.defineStream("VirtualizeAgentSessionWaterfall", {
	messages: [Message.ChangedWaterfallWindow],
	execute: ({ element, viewStateChanges }) =>
		viewStateChanges.pipe(
			Stream.switchMap((viewState) =>
				viewState === "Live" && element instanceof HTMLElement
					? virtualize(
							element,
							{ overscan: 16, isMeasured: false, rows: ":scope > div > [data-index]" },
							(window) => Message.ChangedWaterfallWindow({ window }),
						)
					: Stream.never,
			),
		),
})

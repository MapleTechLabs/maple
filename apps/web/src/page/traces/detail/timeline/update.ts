import * as Select from "../../../../ui/select"
import {
	collectAllCollapsibleIds,
	collectDescendantParentIds,
	computeCollapseOneLevel,
	computeDefaultExpandedSpanIds,
	computeExpandOneLevel,
} from "@maple/ui/components/traces/auto-collapse"
import { clampViewport, viewportBounds } from "@maple/ui/components/traces/clamp-viewport"
import {
	colorByFieldId,
	colorByFromId,
	DEFAULT_COLOR_BY,
	type ColorByField,
} from "@maple/ui/components/traces/color-by"
import {
	SIDEBAR_WIDTH_DEFAULT,
	SIDEBAR_WIDTH_MAX,
	SIDEBAR_WIDTH_MIN,
} from "@maple/ui/components/traces/trace-timeline-types"
import { summarizeClockSkew } from "@maple/ui/lib/span-tree"
import { Command } from "foldkit"
import { type SpanEvents, type SpanNodeData, type TraceData, toSpanNode } from "../trace-data"
import { FocusSearch, ReadSidebarWidth, ScrollToRow } from "./command"
import {
	collectParentIdsByLevel,
	computeSearchMatches,
	countSpans,
	defaultViewport,
	layoutSpans,
	type Bar,
	traceBounds,
} from "./layout"
import { Message, OutMessage } from "./message"
import type { Model, Viewport } from "./model"

export type UpdateReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message>>
	outMessage?: OutMessage
}>

export const colorByOf = (id: string): ColorByField => colorByFromId(id) ?? DEFAULT_COLOR_BY

/** The visible rows of the current tree, expansion and color scheme. */
export const barsOf = (model: Model): ReadonlyArray<Bar> =>
	layoutSpans(model.rootSpans, new Set(model.expandedSpanIds), colorByOf(model.colorBy), model.traceStartMs)

const legacyTree = (rootSpans: ReadonlyArray<SpanNodeData>) => rootSpans.map(toSpanNode)

const indexOf = (model: Model, spanId: string): number =>
	barsOf(model).findIndex((bar) => bar.span.spanId === spanId)

export type InitInput = Readonly<{
	trace: TraceData
	traceStartTime: string
	selectedSpanId: string | null
	colorBy: string
	spanEvents: SpanEvents | null
}>

/** `<TraceTimeline />` mounting: default expansion keeps the selected span visible, then scrolls to it. */
/** The picker's value: `colorByFieldId`, the default when the stored one does not parse. */
const colorBySelectValue = (colorBy: string): string =>
	colorByFieldId(colorByFromId(colorBy) ?? DEFAULT_COLOR_BY)

export const init = (input: InitInput): UpdateReturn => {
	const { trace } = input
	const { traceStartMs, traceEndMs } = traceBounds(
		trace.rootSpans,
		input.traceStartTime,
		trace.totalDurationMs,
	)
	const tree = legacyTree(trace.rootSpans)
	const expanded = computeDefaultExpandedSpanIds(
		tree,
		input.selectedSpanId === null ? {} : { keepVisibleSpanId: input.selectedSpanId },
	)
	const model: Model = {
		rootSpans: trace.rootSpans,
		totalDurationMs: trace.totalDurationMs,
		traceStartTime: input.traceStartTime,
		services: [...new Set(trace.spans.map((span) => span.serviceName))],
		totalSpanCount: countSpans(trace.rootSpans),
		skew: summarizeClockSkew(tree),
		traceStartMs,
		traceEndMs,
		viewport: defaultViewport(traceStartMs, traceEndMs),
		expandedSpanIds: [...expanded],
		focusedIndex: null,
		searchQuery: "",
		matchCursor: 0,
		selectedSpanId: input.selectedSpanId,
		colorBy: input.colorBy,
		colorBySelect: Select.init("trace-timeline-color-by", {
			value: colorBySelectValue(input.colorBy),
			selectedIndex: null,
		}),
		spanEvents: input.spanEvents,
		sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
		scrollerWidth: 0,
		scrollerHeight: 0,
		scrollTop: 0,
		hoveredSpanId: null,
		isShowingShortcuts: false,
	}
	const selectedIndex = input.selectedSpanId === null ? -1 : indexOf(model, input.selectedSpanId)
	return {
		model,
		commands: [
			ReadSidebarWidth(),
			...(selectedIndex >= 0 ? [ScrollToRow({ index: selectedIndex })] : []),
		],
	}
}

/** The page changed the selection: scroll the new span into view (no-op when visible). */
export const setSelectedSpanId = (model: Model, spanId: string | null): UpdateReturn => {
	if (spanId === model.selectedSpanId) return { model }
	const next = { ...model, selectedSpanId: spanId }
	const index = spanId === null ? -1 : indexOf(next, spanId)
	return { model: next, commands: index >= 0 ? [ScrollToRow({ index })] : [] }
}

export const setSpanEvents = (model: Model, spanEvents: SpanEvents | null): UpdateReturn => ({
	model: { ...model, spanEvents },
})

export const setColorBy = (model: Model, colorBy: string): UpdateReturn => ({
	model: {
		...model,
		colorBy,
		colorBySelect: { ...model.colorBySelect, value: colorBySelectValue(colorBy) },
	},
})

const setViewport = (model: Model, viewport: Viewport): Model => ({
	...model,
	viewport: clampViewport(viewport, model.traceStartMs, model.traceEndMs),
})

/** Zooms to the span with 10% padding. TODO(animation): ease it; applied at once here. */
const zoomToSpan = (model: Model, startMs: number, endMs: number): Model => {
	const padding = Math.max((endMs - startMs) * 0.1, 0.001)
	return setViewport(model, { startMs: startMs - padding, endMs: endMs + padding })
}

const fit = (model: Model): Model => {
	const { loMs, hiMs } = viewportBounds(model.traceStartMs, model.traceEndMs)
	return setViewport(model, { startMs: loMs, endMs: hiMs })
}

const withExpanded = (model: Model, expanded: ReadonlySet<string>): Model => ({
	...model,
	expandedSpanIds: [...expanded],
})

/** `TOGGLE_COLLAPSE`; `wholeSubtree` drags every descendant parent to the node's new state. */
const toggleCollapse = (model: Model, spanId: string, wholeSubtree: boolean): Model => {
	const next = new Set(model.expandedSpanIds)
	const isExpanding = !next.has(spanId)
	const node = barsOf(model).find((bar) => bar.span.spanId === spanId)?.span
	const descendants = wholeSubtree && node !== undefined ? collectDescendantParentIds(toSpanNode(node)) : []
	;[spanId, ...descendants].forEach((id) => (isExpanding ? next.add(id) : next.delete(id)))
	return withExpanded(model, next)
}

const expandOneLevel = (model: Model): Model =>
	withExpanded(
		model,
		computeExpandOneLevel(new Set(model.expandedSpanIds), collectParentIdsByLevel(model.rootSpans)),
	)

const collapseOneLevel = (model: Model): Model =>
	withExpanded(
		model,
		computeCollapseOneLevel(new Set(model.expandedSpanIds), collectParentIdsByLevel(model.rootSpans)),
	)

/** Enter / Shift+Enter in the search box: cycle the matches, focusing each row. */
const navigateSearch = (model: Model, direction: 1 | -1): UpdateReturn => {
	const bars = barsOf(model)
	const matches = computeSearchMatches(bars, model.searchQuery)
	const rows = bars.flatMap((bar, index) => (matches.has(bar.span.spanId) ? [index] : []))
	const n = rows.length
	if (n === 0) return { model }
	const cursor = model.matchCursor
	const next = cursor === 0 ? (direction === 1 ? 1 : n) : ((cursor - 1 + direction + n) % n) + 1
	const index = rows[next - 1] ?? 0
	return { model: { ...model, matchCursor: next, focusedIndex: index }, commands: [ScrollToRow({ index })] }
}

const focus = (model: Model, index: number | null): UpdateReturn => ({
	model: { ...model, focusedIndex: index },
	commands: index === null ? [] : [ScrollToRow({ index })],
})

/** Cursor-anchored zoom (the viewport centre: the pointer is not tracked yet) and pan. */
const zoomBy = (model: Model, factor: number): Model => {
	const { startMs, endMs } = model.viewport
	const duration = endMs - startMs
	const center = (startMs + endMs) / 2
	const next = duration / factor
	return setViewport(model, { startMs: center - next / 2, endMs: center + next / 2 })
}

const panBy = (model: Model, fraction: number): Model => {
	const delta = (model.viewport.endMs - model.viewport.startMs) * fraction
	return setViewport(model, {
		startMs: model.viewport.startMs + delta,
		endMs: model.viewport.endMs + delta,
	})
}

/** The timeline's own keys (`handleKeyDown`), only while the timeline itself has focus. */
const pressedKey = (model: Model, key: string, isShift: boolean): UpdateReturn => {
	const bars = barsOf(model)
	const focused = model.focusedIndex === null ? undefined : bars[model.focusedIndex]
	switch (key.toLowerCase()) {
		case "arrowdown":
			return focus(
				model,
				model.focusedIndex === null ? 0 : Math.min(model.focusedIndex + 1, bars.length - 1),
			)
		case "arrowup":
			return focus(model, model.focusedIndex === null ? 0 : Math.max(0, model.focusedIndex - 1))
		case "arrowright":
			return focused?.hasChildren === true && focused.isCollapsed
				? { model: toggleCollapse(model, focused.span.spanId, false) }
				: { model }
		case "arrowleft":
			return focused?.hasChildren === true && !focused.isCollapsed
				? { model: toggleCollapse(model, focused.span.spanId, false) }
				: { model }
		case "enter":
		case " ":
			return focused === undefined
				? { model }
				: { model, outMessage: OutMessage.SelectedSpan({ spanId: focused.span.spanId }) }
		case "w":
		case "+":
		case "=":
			return { model: zoomBy(model, isShift ? 2 : 1.4) }
		case "s":
		case "-":
		case "_":
			return { model: zoomBy(model, isShift ? 0.5 : 1 / 1.4) }
		case "a":
			return { model: panBy(model, isShift ? -0.4 : -0.15) }
		case "d":
			return { model: panBy(model, isShift ? 0.4 : 0.15) }
		case "e":
			return { model: isShift ? collapseOneLevel(model) : expandOneLevel(model) }
		case "f": {
			const target =
				focused ??
				(model.selectedSpanId === null
					? undefined
					: bars.find((bar) => bar.span.spanId === model.selectedSpanId))
			return {
				model: target === undefined ? fit(model) : zoomToSpan(model, target.startMs, target.endMs),
			}
		}
		case "/":
			return { model, commands: [FocusSearch()] }
		case "?":
			return { model: { ...model, isShowingShortcuts: !model.isShowingShortcuts } }
		case "escape":
			return model.isShowingShortcuts
				? { model: { ...model, isShowingShortcuts: false } }
				: model.searchQuery !== ""
					? { model: { ...model, searchQuery: "", matchCursor: 0 } }
					: { model: { ...model, focusedIndex: null } }
		default:
			return { model }
	}
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadSidebarWidth: ({ width }) => ({
			model: {
				...model,
				sidebarWidth:
					width === null
						? SIDEBAR_WIDTH_DEFAULT
						: Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, width)),
			},
		}),
		MeasuredScroller: ({ width, height }) => ({
			model: { ...model, scrollerWidth: width, scrollerHeight: height },
		}),
		ScrolledBody: ({ scrollTop }) =>
			scrollTop === model.scrollTop ? { model } : { model: { ...model, scrollTop } },
		CompletedScrollRequest: () => ({ model }),
		CompletedFocusSearch: () => ({ model }),
		// A new query resets the match cursor (`setMatchCursor(0)` on `searchQuery`).
		ChangedSearch: ({ query }) => ({ model: { ...model, searchQuery: query, matchCursor: 0 } }),
		ClickedClearSearch: () => ({ model: { ...model, searchQuery: "", matchCursor: 0 } }),
		PressedSearchKey: ({ key, isShift }) =>
			key === "Enter"
				? navigateSearch(model, isShift ? -1 : 1)
				: key === "Escape"
					? pressedKey(model, "escape", false)
					: { model },
		PressedTimelineKey: ({ key, isShift }) => pressedKey(model, key, isShift),
		ClickedRow: ({ spanId }) => ({ model, outMessage: OutMessage.SelectedSpan({ spanId }) }),
		DoubleClickedRow: ({ spanId }) => {
			const bar = barsOf(model).find((candidate) => candidate.span.spanId === spanId)
			return { model: bar === undefined ? model : zoomToSpan(model, bar.startMs, bar.endMs) }
		},
		ClickedToggleCollapse: ({ spanId }) => ({ model: toggleCollapse(model, spanId, false) }),
		AltClickedToggleCollapse: ({ spanId }) => ({ model: toggleCollapse(model, spanId, true) }),
		HoveredRow: ({ spanId }) =>
			spanId === model.hoveredSpanId ? { model } : { model: { ...model, hoveredSpanId: spanId } },
		ClickedCollapseOneLevel: () => ({ model: collapseOneLevel(model) }),
		ClickedExpandOneLevel: () => ({ model: expandOneLevel(model) }),
		ClickedCollapseAll: () => ({ model: withExpanded(model, new Set()) }),
		ClickedExpandAll: () => ({
			model: withExpanded(model, collectAllCollapsibleIds(legacyTree(model.rootSpans))),
		}),
		ClickedFit: () => ({ model: fit(model) }),
		ClickedShortcuts: () => ({ model: { ...model, isShowingShortcuts: !model.isShowingShortcuts } }),
		ClickedCloseShortcuts: () => ({ model: { ...model, isShowingShortcuts: false } }),
		ClickedShortcutsSheet: () => ({ model }),
		GotColorBySelectMessage: ({ message: inner }) => {
			const next = Select.update(model.colorBySelect, inner)
			const lifted: UpdateReturn = {
				model: { ...model, colorBySelect: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotColorBySelectMessage({ message }),
				),
			}
			const value = next.outMessage?.value
			return value === undefined || value === model.colorBy || colorByFromId(value) === undefined
				? lifted
				: { ...lifted, outMessage: OutMessage.ChangedColorBy({ colorBy: value }) }
		},
		SelectedColorBy: ({ colorBy }) =>
			colorBy === model.colorBy
				? { model }
				: { model, outMessage: OutMessage.ChangedColorBy({ colorBy }) },
	})

/** The keys `pressedKey` consumes (and `preventDefault`s). */
export const TIMELINE_KEYS = new Set([
	"arrowdown",
	"arrowup",
	"arrowright",
	"arrowleft",
	"enter",
	" ",
	"w",
	"+",
	"=",
	"s",
	"-",
	"_",
	"a",
	"d",
	"e",
	"f",
	"/",
	"?",
	"escape",
])

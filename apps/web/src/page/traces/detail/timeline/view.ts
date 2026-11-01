import { SIDEBAR_WIDTH_NARROW_MIN } from "@maple/ui/components/traces/trace-timeline-types"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../../ui/empty"
import { MountAltToggle, MeasureTimelineBody } from "./command"
import { type Bar, computeSearchMatches, computeTimeAxisTicks, ROW_PITCH, virtualRange } from "./layout"
import { Message } from "./message"
import type { Model } from "./model"
import { barsOf, TIMELINE_KEYS } from "./update"
import { minimap, searchBar, tickLeft, timeAxis, toolbar, type ToolbarIds } from "./view-chrome"
import { footer, shortcutsOverlay } from "./view-footer"
import { timelineRow } from "./view-row"

// `TraceTimeline` (packages/ui/src/components/traces/trace-timeline.tsx): what its tab panel holds.
// TODO(gestures): drag-zoom marquee, shift/middle-drag pan, ctrl+wheel zoom, minimap drags, the
// crosshair readout, the sidebar resize drag and the hover tooltip are not ported yet.

export type ViewInputs = Readonly<{
	/** Prefix for Base UI style ids (tooltip and select triggers). */
	idPrefix: string
}>

type H = HtmlBuilder<Message>

/** `effectiveSidebarWidth`: never more than half a narrow pane. */
export const effectiveSidebarWidth = (model: Model): number =>
	model.scrollerWidth > 0
		? Math.max(
				SIDEBAR_WIDTH_NARROW_MIN,
				Math.min(model.sidebarWidth, Math.round(model.scrollerWidth * 0.5)),
			)
		: model.sidebarWidth

const toolbarIds = (prefix: string): ToolbarIds => ({
	depth: [
		`${prefix}-collapse-one`,
		`${prefix}-expand-one`,
		`${prefix}-collapse-all`,
		`${prefix}-expand-all`,
	],
	fit: `${prefix}-fit`,
	skew: `${prefix}-skew`,
	colorBy: `${prefix}-color-by`,
})

const alignedStrip = (h: H, spacerClass: string, rowClass: string, cellClass: string, child: Html): Html =>
	h.div(
		[h.Class(rowClass)],
		[
			h.div([h.Class(spacerClass), h.Style({ width: "var(--sidebar-w)" })], []),
			h.div([h.Class(cellClass)], [child]),
		],
	)

const body = (
	h: H,
	model: Model,
	inputs: ViewInputs,
	sidebarWidth: number,
	bars: ReadonlyArray<Bar>,
	matches: ReadonlySet<string>,
	ticks: ReadonlyArray<number>,
): Html => {
	const isSearchActive = model.searchQuery.trim().length > 0
	const visible = model.viewport.endMs - model.viewport.startMs
	const vp0 = model.viewport.startMs - model.traceStartMs
	const k = 100 / visible
	const rows = virtualRange(bars.length, model.scrollTop, model.scrollerHeight).flatMap((index) => {
		const bar = bars[index]
		if (bar === undefined) return []
		const spanId = bar.span.spanId
		const isMatched = isSearchActive && matches.has(spanId)
		return [
			timelineRow(h, bar, {
				top: index * ROW_PITCH,
				isSelected: model.selectedSpanId === spanId,
				isFocused: model.focusedIndex === index,
				isHovered: model.hoveredSpanId === spanId,
				isDimmed: isSearchActive && !isMatched,
				isMatched,
				showService: model.services.length > 1,
				events: model.spanEvents?.[spanId],
				leftPct: (bar.offsetStartMs - vp0) * k,
				rightPct: (bar.offsetEndMs - vp0) * k,
				markerId: (marker) => `${inputs.idPrefix}-event-${spanId}-${marker}`,
			}),
		]
	})
	return h.div(
		[h.Class("relative flex flex-1 min-h-0")],
		[
			h.div(
				[
					h.Attribute("class", "flex-1 overflow-auto select-none "),
					h.Style({ "scrollbar-gutter": "stable" }),
					h.OnScroll((scrollTop) => Message.ScrolledBody({ scrollTop })),
					h.OnMount(MeasureTimelineBody()),
				],
				[
					h.div(
						[
							h.Class("relative w-full"),
							h.OnMount(MountAltToggle()),
							h.Style({
								height: `${bars.length * ROW_PITCH}px`,
								"--vp0": String(vp0),
								"--vpk": String(visible > 0 ? 100 / visible : 0),
							}),
						],
						[
							h.div(
								[
									h.AriaHidden(true),
									h.Class("pointer-events-none absolute inset-y-0 right-0 z-0"),
									h.Style({ left: "var(--sidebar-w)" }),
								],
								ticks.map((offset) =>
									h.span(
										[
											h.Attribute(
												"class",
												"pointer-events-none absolute inset-y-0 w-px bg-border-subtle",
											),
											h.Style({ left: tickLeft(offset, model) }),
										],
										[],
									),
								),
							),
							...rows,
						],
					),
				],
			),
			h.div(
				[
					h.AriaOrientation("vertical"),
					h.Class(
						"absolute top-0 bottom-0 z-30 w-1 -ml-0.5 cursor-col-resize bg-transparent hover:bg-primary-a3 active:bg-primary-a3 pointer-coarse:hidden",
					),
					h.Role("separator"),
					h.Style({ left: `${sidebarWidth}px` }),
				],
				[],
			),
			h.div(
				[
					h.Class("pointer-events-none absolute top-0 bottom-0 left-0 z-20 w-px bg-foreground/40"),
					h.Style({ display: "none" }),
				],
				[
					h.span(
						[
							h.Class(
								"absolute top-1 whitespace-nowrap bg-background/90 px-1 font-mono text-4xs leading-3 text-muted-foreground",
							),
						],
						[],
					),
				],
			),
		],
	)
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	if (model.rootSpans.length === 0)
		return emptyMessage(h, { className: "border p-8 text-sm" }, ["No spans found for this trace"])
	const sidebarWidth = effectiveSidebarWidth(model)
	const bars = barsOf(model)
	const matches = computeSearchMatches(bars, model.searchQuery)
	const { ticks, intervalMs } = computeTimeAxisTicks(
		model.viewport,
		model.traceStartMs,
		Math.max(0, model.scrollerWidth - sidebarWidth),
	)
	return h.div(
		[
			h.Class("@container/timeline border flex flex-col h-full outline-none relative"),
			h.Style({ "--sidebar-w": `${sidebarWidth}px` }),
			h.Tabindex(0),
			h.OnKeyDownSelfPreventDefault((key, modifiers) =>
				TIMELINE_KEYS.has(key.toLowerCase())
					? Option.some(Message.PressedTimelineKey({ key, isShift: modifiers.shiftKey }))
					: Option.none(),
			),
		],
		[
			searchBar(h, model, matches.size, bars.length),
			toolbar(h, model, bars.length, toolbarIds(inputs.idPrefix)),
			alignedStrip(
				h,
				"shrink-0 border-b border-r border-border bg-surface-faint",
				"flex shrink-0",
				"flex-1 min-w-0",
				minimap(h, model),
			),
			alignedStrip(
				h,
				"shrink-0 border-r border-border",
				"flex border-b border-border shrink-0",
				"flex-1 min-w-0 relative bg-background",
				timeAxis(h, model, ticks, intervalMs),
			),
			body(h, model, inputs, sidebarWidth, bars, matches, ticks),
			footer(h, model),
			...(model.isShowingShortcuts ? [shortcutsOverlay(h)] : []),
		],
	)
})

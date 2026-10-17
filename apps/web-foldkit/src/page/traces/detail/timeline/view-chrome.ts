import { colorByFromId, colorByLabel, DEFAULT_COLOR_BY } from "@maple/ui/components/traces/color-by"
import { viewportBounds } from "@maple/ui/components/traces/clamp-viewport"
import { MINIMAP_HEIGHT, TIME_AXIS_HEIGHT } from "@maple/ui/components/traces/trace-timeline-types"
import { formatDurationAtStep } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	selectTriggerIconClassName,
	selectTriggerVariants,
	selectValueStyles,
} from "@maple/ui/styles/ui/select"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { icon } from "../../../../ui/icon"
import { SR_ONLY_STYLE } from "../../../../ui/overlay/transition"
import { depthControls } from "../depth-controls"
import { collectMinimapSpans } from "./layout"
import { Message } from "./message"
import type { Model } from "./model"

// The Timeline's chrome: `TraceTimelineSearch`, the toolbar with `TraceDepthControls`, the fit
// button and `ColorByPicker`, `TraceTimelineMinimap` and `TraceTimelineTimeAxis`.

type H = HtmlBuilder<Message>

export const searchBar = (h: H, model: Model, matchCount: number, totalCount: number): Html =>
	h.div(
		[h.Class("flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5")],
		[
			icon(h, "MagnifierIcon", { size: 13, className: "text-muted-foreground shrink-0" }),
			h.input([
				h.Class(
					"min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50 pointer-coarse:text-base",
				),
				h.Placeholder("Search spans…"),
				h.Type("text"),
				h.Value(model.searchQuery),
				h.OnInput((query) => Message.ChangedSearch({ query })),
				h.OnKeyDownPreventDefault((key, modifiers) =>
					(key === "Enter" && matchCount > 0) || key === "Escape"
						? Option.some(Message.PressedSearchKey({ key, isShift: modifiers.shiftKey }))
						: Option.none(),
				),
			]),
			...(model.searchQuery === ""
				? []
				: [
						h.span(
							[h.Class("text-3xs font-mono text-muted-foreground shrink-0 tabular-nums")],
							[
								model.matchCursor > 0
									? `${model.matchCursor}/${matchCount}`
									: `${matchCount} of ${totalCount}`,
							],
						),
						h.button(
							[
								h.AriaLabel("Clear search"),
								h.Class("-m-1.5 shrink-0 p-1.5 text-muted-foreground hover:text-foreground"),
								h.Type("button"),
								h.OnClick(Message.ClickedClearSearch()),
							],
							[icon(h, "XmarkIcon", { size: 12 })],
						),
					]),
		],
	)

/**
 * `ColorByPicker`'s closed trigger, Base UI Select markup.
 * TODO(color-by-popup): the option list is not ported; `ui/select` needs a trigger prefix
 * ("Color:") and the `sm` size before this can sit on it.
 */
const colorByTrigger = (h: H, model: Model, triggerId: string): ReadonlyArray<Html> => [
	h.button(
		[
			h.AriaExpanded(false),
			h.AriaHasPopup("listbox"),
			h.Class(
				cn(
					selectTriggerVariants({
						size: "sm",
						className: "h-5 min-w-0 text-3xs gap-1 px-2 py-0 rounded-md",
					}),
				),
			),
			h.DataAttribute("slot", "select-trigger"),
			h.Id(triggerId),
			h.Role("combobox"),
			h.Tabindex(0),
			h.Type("button"),
		],
		[
			h.span([h.Class("text-muted-foreground")], ["Color:"]),
			h.span(
				[h.Class(selectValueStyles), h.DataAttribute("slot", "select-value")],
				[colorByLabel(colorByFromId(model.colorBy) ?? DEFAULT_COLOR_BY)],
			),
			h.span(
				[h.AriaHidden(true), h.DataAttribute("slot", "select-icon")],
				[icon(h, "ChevronExpandYIcon", { className: selectTriggerIconClassName })],
			),
		],
	),
	h.input([
		h.AriaHidden(true),
		h.Id(`${triggerId}-hidden-input`),
		h.Style(SR_ONLY_STYLE),
		h.Tabindex(-1),
		h.Value(model.colorBy),
	]),
]

export type ToolbarIds = Readonly<{
	depth: readonly [string, string, string, string]
	fit: string
	skew: string
	colorBy: string
}>

export const toolbar = (h: H, model: Model, visibleSpanCount: number, ids: ToolbarIds): Html =>
	h.div(
		[h.Class("flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 shrink-0")],
		[
			depthControls(h, {
				onCollapseOneLevel: Message.ClickedCollapseOneLevel(),
				onExpandOneLevel: Message.ClickedExpandOneLevel(),
				onCollapseAll: Message.ClickedCollapseAll(),
				onExpandAll: Message.ClickedExpandAll(),
				triggerIds: ids.depth,
			}),
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					className: "h-5 w-5 p-0 pointer-coarse:size-7",
					slot: "tooltip-trigger",
					attributes: [
						h.AriaLabel("Fit trace to view"),
						h.DataAttribute("base-ui-tooltip-trigger", ""),
						h.Id(ids.fit),
						h.OnClick(Message.ClickedFit()),
					],
				},
				[icon(h, "AspectRatioIcon")],
			),
			h.div(
				[h.Class("ml-auto flex min-w-0 items-center gap-2 text-3xs text-muted-foreground")],
				[
					...(visibleSpanCount < model.totalSpanCount
						? [
								h.span(
									[h.Class("shrink-0 tabular-nums")],
									[
										String(visibleSpanCount),
										" of ",
										String(model.totalSpanCount),
										h.span([h.Class("hidden @min-[420px]/timeline:inline")], [" spans"]),
									],
								),
							]
						: []),
					...(model.skew === null
						? []
						: [
								h.span(
									[
										h.Class(
											"flex shrink-0 cursor-default items-center gap-1 text-severity-warn",
										),
										h.DataAttribute("base-ui-tooltip-trigger", ""),
										h.DataAttribute("slot", "tooltip-trigger"),
										h.Id(ids.skew),
									],
									[
										icon(h, "AlertWarningIcon", { size: 11 }),
										h.span([h.Class("hidden @min-[400px]/timeline:inline")], ["skew"]),
									],
								),
							]),
					...colorByTrigger(h, model, ids.colorBy),
				],
			),
		],
	)

/** `TraceTimelineMinimap` at rest: the span silhouette, masks and the viewport rect. */
export const minimap = (h: H, model: Model): Html => {
	const { loMs: domainStartMs, durationMs: domainDuration } = viewportBounds(
		model.traceStartMs,
		model.traceEndMs,
	)
	const { spans, maxDepth } = collectMinimapSpans(
		model.rootSpans,
		domainStartMs,
		domainDuration,
		colorByFromId(model.colorBy) ?? DEFAULT_COLOR_BY,
	)
	const pitch = Math.max(1, Math.min(4, Math.floor((MINIMAP_HEIGHT - 4) / (maxDepth + 1))))
	const rowH = Math.max(1, pitch - 1)
	const clampFrac = (value: number) => Math.max(0, Math.min(1, value))
	const start = clampFrac((model.viewport.startMs - domainStartMs) / domainDuration)
	const end = clampFrac((model.viewport.endMs - domainStartMs) / domainDuration)
	const leftPct = start * 100
	const widthPct = Math.min(Math.max((end - start) * 100, 0.5), 100 - leftPct)
	return h.div(
		[
			h.Class(
				"relative overflow-hidden border-b border-border bg-muted/10 cursor-crosshair select-none touch-none",
			),
			h.Style({ height: `${MINIMAP_HEIGHT}px` }),
			h.Title(
				"Drag to select a range · click to jump · drag the edges to resize · double-click to fit",
			),
			h.OnDoubleClick(Message.ClickedFit()),
		],
		[
			h.div(
				[
					h.Class("pointer-events-none absolute inset-0"),
					h.Style({ "padding-top": "2px", "padding-bottom": "2px" }),
				],
				spans.map((span) =>
					h.div(
						[
							h.Attribute("class", "absolute"),
							h.Style({
								top: `${Math.min(2 + span.depth * pitch, MINIMAP_HEIGHT - rowH - 2)}px`,
								left: `${span.leftPercent}%`,
								width: `${Math.max(span.widthPercent, 0.2)}%`,
								height: `${rowH}px`,
								"background-color": span.bgColor,
							}),
						],
						[],
					),
				),
			),
			h.div(
				[
					h.Class("pointer-events-none absolute inset-y-0 left-0 bg-background/60"),
					h.Style({ width: `${leftPct}%` }),
				],
				[],
			),
			h.div(
				[
					h.Class("pointer-events-none absolute inset-y-0 right-0 bg-background/60"),
					h.Style({ left: `${leftPct + widthPct}%` }),
				],
				[],
			),
			h.div(
				[
					h.Class(
						"pointer-events-none absolute inset-y-0 border-x border-primary/70 bg-primary/15",
					),
					h.Style({ display: "none" }),
				],
				[],
			),
			h.div(
				[
					h.Class("pointer-events-none absolute inset-y-0 left-0 w-px bg-foreground/40"),
					h.Style({ display: "none" }),
				],
				[
					h.span(
						[
							h.Class(
								"absolute top-0 whitespace-nowrap bg-background/90 px-1 font-mono text-4xs leading-3 text-muted-foreground",
							),
						],
						[],
					),
				],
			),
			h.div(
				[
					h.Class("pointer-events-none absolute inset-y-0 border-x-2 border-primary/60"),
					h.Style({ left: `${leftPct}%`, width: `${widthPct}%` }),
				],
				[],
			),
		],
	)
}

/** One tick of the ruler or the grid behind the rows, at its viewport percentage. */
export const tickLeft = (offset: number, model: Model): string => {
	const visible = model.viewport.endMs - model.viewport.startMs
	const vp0 = model.viewport.startMs - model.traceStartMs
	return `${((offset - vp0) / visible) * 100}%`
}

export const timeAxis = (h: H, model: Model, ticks: ReadonlyArray<number>, intervalMs: number): Html =>
	h.div(
		[h.AriaHidden(true), h.Class("relative h-full w-full"), h.Style({ height: `${TIME_AXIS_HEIGHT}px` })],
		ticks.map((offset) =>
			h.span(
				[
					h.Attribute(
						"class",
						"pointer-events-none absolute bottom-1 -translate-x-1/2 whitespace-nowrap font-mono text-3xs font-medium text-muted-foreground",
					),
					h.Style({ left: tickLeft(offset, model) }),
				],
				[formatDurationAtStep(offset, intervalMs)],
			),
		),
	)

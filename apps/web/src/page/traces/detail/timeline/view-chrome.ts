import { colorByFromId, colorByLabel, DEFAULT_COLOR_BY } from "@maple/ui/components/traces/color-by"
import { viewportBounds } from "@maple/ui/components/traces/clamp-viewport"
import { MINIMAP_HEIGHT, TIME_AXIS_HEIGHT } from "@maple/ui/components/traces/trace-timeline-types"
import { countLabel, formatDurationAtStep } from "@maple/ui/lib/format"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bareInput } from "../../../../ui/bare-input"
import { button } from "../../../../ui/button"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import * as SelectView from "../../../../ui/select-view"
import type { SpanNodeData } from "../trace-data"
import { depthControls } from "../depth-controls"
import { collectMinimapSpans } from "./layout"
import { Message } from "./message"
import type { Model } from "./model"

// The Timeline's chrome: `TraceTimelineSearch`, the toolbar with `TraceDepthControls`, the fit
// button and `ColorByPicker`, `TraceTimelineMinimap` and `TraceTimelineTimeAxis`.

type H = HtmlBuilder<Message>

export const searchBar = (h: H, model: Model, matchCount: number, totalCount: number): Html =>
	h.div(
		[h.Class("flex items-center gap-2 border-b border-border bg-surface-faint px-3 py-1.5")],
		[
			icon(h, "MagnifierIcon", { size: 14, className: "text-muted-foreground shrink-0" }),
			bareInput(h, {
				className:
					"flex-1 font-mono text-xs text-foreground placeholder:text-foreground-faint pointer-coarse:text-base",
				attributes: [
					h.Placeholder("Search spans…"),
					h.Type("text"),
					h.Value(model.searchQuery),
					h.OnInput((query) => Message.ChangedSearch({ query })),
					h.OnKeyDownPreventDefault((key, modifiers) =>
						(key === "Enter" && matchCount > 0) || key === "Escape"
							? Option.some(Message.PressedSearchKey({ key, isShift: modifiers.shiftKey }))
							: Option.none(),
					),
				],
			}),
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
						iconButton(
							h,
							{
								label: "Clear search",
								size: "icon-2xs",
								hasTooltip: false,
								className: "shrink-0 text-muted-foreground hover:text-foreground active:text-foreground",
								attributes: [h.OnClick(Message.ClickedClearSearch())],
							},
							[icon(h, "XmarkIcon", { size: 12 })],
						),
					]),
		],
	)

type AttributeKey = Readonly<{ kind: "spanAttribute" | "resourceAttribute"; key: string; count: number }>

const MAX_KEYS_PER_SOURCE = 20

const countKeys = (
	spans: ReadonlyArray<SpanNodeData>,
	read: (span: SpanNodeData) => Readonly<Record<string, string>>,
) => {
	const counts = new Map<string, number>()
	// The trace query projects fixed keys as "" when a span lacks them; only real values count.
	const visit = (span: SpanNodeData): void => {
		Object.entries(read(span)).forEach(([key, value]) => {
			if (value !== "") counts.set(key, (counts.get(key) ?? 0) + 1)
		})
		span.children.forEach(visit)
	}
	spans.forEach(visit)
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, MAX_KEYS_PER_SOURCE)
}

/** `useTraceAttributeKeys`: the trace's commonest span and resource attribute keys, 20 of each. */
export const attributeKeys = (rootSpans: ReadonlyArray<SpanNodeData>): ReadonlyArray<AttributeKey> => [
	...countKeys(rootSpans, (span) => span.spanAttributes).map(([key, count]) => ({
		kind: "spanAttribute" as const,
		key,
		count,
	})),
	...countKeys(rootSpans, (span) => span.resourceAttributes).map(([key, count]) => ({
		kind: "resourceAttribute" as const,
		key,
		count,
	})),
]

const PRESETS = ["preset:service", "preset:spanKind", "preset:statusCode"] as const

/** `ColorByPicker`'s groups: presets, then the trace's span and resource attribute keys. */
const colorByEntries = (rootSpans: ReadonlyArray<SpanNodeData>): ReadonlyArray<SelectView.SelectEntry> => {
	const keys = attributeKeys(rootSpans)
	const group = (label: string, kind: AttributeKey["kind"]): ReadonlyArray<SelectView.SelectEntry> => {
		const items = keys.filter((key) => key.kind === kind)
		return items.length === 0
			? []
			: [
					{ _tag: "Separator" },
					{
						_tag: "Group",
						label,
						isSelectLabel: true,
						items: items.map((key) => ({
							value: `${kind === "spanAttribute" ? "span" : "resource"}:${key.key}`,
							label: key.key,
							title: countLabel(key.count, "span"),
						})),
					},
				]
	}
	return [
		{
			_tag: "Group",
			label: "Presets",
			isSelectLabel: true,
			items: PRESETS.map((id) => ({
				value: id,
				label: colorByLabel(colorByFromId(id) ?? DEFAULT_COLOR_BY),
			})),
		},
		...group("Span attributes", "spanAttribute"),
		...group("Resource attributes", "resourceAttribute"),
	]
}

/** `ColorByPicker`: a small Select whose trigger reads "Color: Service". */
const colorByPicker = (h: H, model: Model): Html =>
	h.submodel({
		slotId: model.colorBySelect.id,
		model: model.colorBySelect,
		view: SelectView.view,
		viewInputs: {
			entries: colorByEntries(model.rootSpans),
			size: "sm",
			labelledBy: SelectView.selectLabelId(model.colorBySelect.id),
			className: "h-5 min-w-0 text-3xs gap-1 px-2 py-0 rounded-md",
			leading: [h.span([h.Class("text-muted-foreground")], ["Color:"])],
			renderValue: (value) => [colorByLabel(colorByFromId(value) ?? DEFAULT_COLOR_BY)],
			renderItem: (option) =>
				option.value.startsWith("span:")
					? [h.span([h.Class("font-mono")], [option.label])]
					: option.value.startsWith("resource:")
						? [
								h.span([h.Class("text-muted-foreground mr-1")], ["R:"]),
								h.span([h.Class("font-mono")], [option.label]),
							]
						: [option.label],
			toView: (parts) => h.span([h.Class("contents")], parts),
		},
		toParentMessage: (message) => Message.GotColorBySelectMessage({ message }),
	})

export type ToolbarIds = Readonly<{
	depth: readonly [string, string, string, string]
	fit: string
	skew: string
	colorBy: string
}>

export const toolbar = (h: H, model: Model, visibleSpanCount: number, ids: ToolbarIds): Html =>
	h.div(
		[h.Class("flex items-center gap-2 border-b border-border bg-surface-sunken px-3 py-1.5 shrink-0")],
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
										icon(h, "AlertWarningIcon", { size: 12 }),
										h.span([h.Class("hidden @min-[400px]/timeline:inline")], ["skew"]),
									],
								),
							]),
					colorByPicker(h, model),
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
				"relative overflow-hidden border-b border-border bg-surface-faint cursor-crosshair select-none touch-none",
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
						"pointer-events-none absolute inset-y-0 border-x border-primary/70 bg-primary-a2",
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

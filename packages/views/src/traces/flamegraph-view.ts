import { getServiceColor, getSpanColorStyle } from "@maple/ui/lib/colors"
import { formatDuration } from "@maple/ui/lib/format"
import { spanStartMs } from "@maple/ui/lib/span-tree"
import type { SpanNode } from "@maple/ui/lib/types"
import { cn } from "@maple/ui/lib/utils"
import { Mount } from "foldkit"
import { Option, Array as Arr } from "effect"
import { type ChildAttribute, createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "../ui/button"
import { XmarkIcon } from "../ui/control-icons"
import { kbd } from "../ui/display"
import { emptyMessage } from "../ui/empty"
import { iconNode } from "../ui/icon"
import * as Tooltip from "../ui/tooltip"
import { barTriggerId, focusedSpan, Message, type Model, MountFlamegraph } from "./flamegraph"
import {
	type FlamegraphBar,
	type FlamegraphInput,
	type FlamegraphLayout,
	flamegraphBars,
	minimapBars,
} from "./flamegraph-layout"
import { spanTooltipContent } from "./span-tooltip"

// The view of `Flamegraph` and `FlamegraphMinimap` (packages/ui `traces/flamegraph*.tsx`).

const ROW_HEIGHT = 32
const ROW_GAP = 2
const HEADER_HEIGHT = 40
const TICKS = [0, 25, 50, 75, 100] as const
const MINIMAP_ROW = 4

const px = (value: number): string => `${value}px`

const errorDot = <M>(h: HtmlBuilder<M>): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class("size-2.5 shrink-0 rounded-dot bg-severity-error [corner-shape:squircle]"),
	])

const serviceDot = <M>(h: HtmlBuilder<M>, service: string): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class("size-2.5 shrink-0 rounded-dot [corner-shape:squircle]"),
		h.Style({ "background-color": getServiceColor(service) }),
	])

const header = <M>(h: HtmlBuilder<M>, focused: Option.Option<SpanNode>, onReset: M): Html =>
	h.div(
		[h.Class("flex items-center justify-between border-b bg-surface-sunken px-3 py-2")],
		[
			h.div(
				[h.Class("flex items-center gap-2 text-xs font-medium text-muted-foreground")],
				[
					h.span([], ["Flamegraph"]),
					...Option.match(focused, {
						onNone: () => [],
						onSome: (span) => [
							h.span([h.Class("text-foreground-subtle")], ["/"]),
							h.span([h.Class("font-mono text-foreground")], [span.spanName]),
							h.span(
								[h.Class("text-foreground-subtle")],
								[`(${formatDuration(span.durationMs)})`],
							),
						],
					}),
				],
			),
			...(Option.isSome(focused)
				? [
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								className: "h-6 gap-1 text-xs",
								attributes: [h.OnClick(onReset)],
							},
							[iconNode(h, XmarkIcon, "XmarkIcon"), "Reset"],
						),
					]
				: []),
		],
	)

const minimap = <M>(h: HtmlBuilder<M>, input: FlamegraphInput, focused: SpanNode): Html => {
	const { bars, maxDepth } = minimapBars(input)
	const traceStartMs = new Date(input.traceStartTime).getTime()
	const left = ((spanStartMs(focused) - traceStartMs) / input.totalDurationMs) * 100
	const width = (focused.durationMs / input.totalDurationMs) * 100
	return h.div(
		[
			h.Class("relative border-b bg-surface-faint cursor-crosshair select-none touch-none"),
			h.Style({ height: px(Math.min((maxDepth + 1) * MINIMAP_ROW + 8, 60)) }),
			h.DataAttribute("flame-minimap", ""),
		],
		[
			h.div(
				[h.Class("absolute inset-x-3 inset-y-1"), h.DataAttribute("flame-minimap-track", "")],
				Arr.map(bars, (bar) =>
					h.div([
						h.Class("absolute opacity-80"),
						h.Style({
							top: px(bar.depth * MINIMAP_ROW),
							left: `${bar.leftPercent}%`,
							width: `${Math.max(bar.widthPercent, 0.3)}%`,
							height: px(MINIMAP_ROW - 1),
							...(bar.span.statusCode === "Error"
								? { "background-color": "var(--destructive)" }
								: colorStyle(bar.span)),
						}),
					]),
				),
			),
			// In the track's coordinates, so the box sits over the spans it frames.
			h.div(
				[h.Class("pointer-events-none absolute inset-x-3 inset-y-0")],
				[
					h.div([
						h.Class("absolute inset-y-0 border-2 border-primary bg-primary-a3"),
						h.Style({ left: `${left}%`, width: `${Math.max(width, 2)}%` }),
					]),
				],
			),
			h.div(
				[h.Class("absolute right-3 top-1 text-4xs font-medium text-foreground-subtle")],
				["Minimap"],
			),
		],
	)
}

const colorStyle = (span: SpanNode): Readonly<Record<string, string>> => {
	const style = getSpanColorStyle(span.spanName, span.serviceName)
	return { "background-color": style.backgroundColor, color: style.color }
}

const barClass = (
	bar: FlamegraphBar,
	focusedId: Option.Option<string>,
	selectedId: Option.Option<string>,
): string =>
	cn(
		"absolute flex items-center overflow-hidden px-2 text-left font-mono text-2xs font-medium cursor-pointer transition-[filter,box-shadow] duration-100",
		"hover:brightness-125 active:brightness-125 hover:z-10 active:z-10",
		bar.span.statusCode === "Error" && "bg-severity-error text-white",
		Option.contains(focusedId, bar.span.spanId) &&
			"ring-2 ring-foreground ring-offset-1 ring-offset-background",
		Option.contains(selectedId, bar.span.spanId) &&
			"ring-2 ring-primary ring-offset-1 ring-offset-background z-20",
	)

const barLabel = <M>(h: HtmlBuilder<M>, bar: FlamegraphBar): ReadonlyArray<Html> =>
	bar.widthPercent > 3
		? [
				h.span([h.Class("truncate")], [bar.span.spanName]),
				...(bar.widthPercent > 12
					? [h.span([h.Class("ml-1 truncate text-3xs opacity-60")], [bar.span.serviceName])]
					: []),
				h.span(
					[h.Class("ml-auto shrink-0 pl-2 text-3xs opacity-70")],
					[formatDuration(bar.span.durationMs)],
				),
			]
		: []

const barStyle = (bar: FlamegraphBar): Readonly<Record<string, string>> => {
	const geometry = {
		top: px(bar.lane * (ROW_HEIGHT + ROW_GAP)),
		left: `${bar.leftPercent}%`,
		width: `${Math.max(bar.widthPercent, 0.5)}%`,
		height: px(ROW_HEIGHT),
		opacity: String(Math.max(1 - bar.depth * 0.06, 0.5)),
	}
	// An error bar takes its colour from `bg-severity-error` instead.
	return bar.span.statusCode === "Error" ? geometry : { ...geometry, ...colorStyle(bar.span) }
}

const barView = <M>(
	h: HtmlBuilder<M>,
	bar: FlamegraphBar,
	trigger: ReadonlyArray<ChildAttribute>,
	focusedId: Option.Option<string>,
	selectedId: Option.Option<string>,
): Html =>
	h.keyed("button")(
		bar.span.spanId,
		[
			...trigger,
			h.Type("button"),
			h.DataAttribute("flame-bar", bar.span.spanId),
			h.Class(barClass(bar, focusedId, selectedId)),
			h.Style(barStyle(bar)),
			// A bar too narrow for its label still names its span.
			...(bar.widthPercent > 3 ? [] : [h.AriaLabel(bar.span.spanName)]),
		],
		barLabel(h, bar),
	)

const footer = <M>(h: HtmlBuilder<M>, services: ReadonlyArray<string>): Html =>
	h.div(
		[
			h.Class(
				"flex items-center justify-between border-t bg-surface-sunken px-3 py-2 text-2xs text-muted-foreground",
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-3 text-foreground-faint")],
				[
					h.span([], [kbd(h, "h-4 font-mono text-3xs", ["Click"]), " select"]),
					h.span([], [kbd(h, "h-4 font-mono text-3xs", ["Shift+Click"]), " zoom"]),
				],
			),
			h.div(
				[h.Class("flex items-center gap-3")],
				[
					...Arr.map(services, (service) =>
						h.div(
							[h.Class("flex items-center gap-1.5")],
							[serviceDot(h, service), h.span([h.Class("font-medium")], [service])],
						),
					),
					h.div(
						[h.Class("flex items-center gap-1.5")],
						[errorDot(h), h.span([h.Class("font-medium")], ["Error"])],
					),
				],
			),
		],
	)

export interface FlamegraphViewInputs {
	readonly input: FlamegraphInput
	/** The parent's selected span: ringed in the primary colour. */
	readonly selectedSpanId: Option.Option<string>
}

type Trigger = (id: string) => ReadonlyArray<ChildAttribute>

/**
 * The latest `trigger` per flamegraph, read only when the bars rebuild. Its attributes vary only by
 * which trigger is open (a lazy key below), and its handlers by the frame, which the lazy checks.
 */
const triggers = new Map<string, { current: Trigger }>()
const barsSlot = createKeyedLazy()

const barsLayer = <M>(
	h: HtmlBuilder<M>,
	modelId: string,
	layout: FlamegraphLayout,
	focusedId: Option.Option<string>,
	selectedId: Option.Option<string>,
	_openTriggerId: string,
	trigger: { current: Trigger },
): Html =>
	h.div(
		[
			h.Class("relative px-3 pt-2"),
			h.Style({ height: px(layout.totalLanes * (ROW_HEIGHT + ROW_GAP) + 8) }),
		],
		[
			...Arr.map(TICKS, (pct) =>
				h.div([
					h.Class(
						"absolute top-0 bottom-0 border-l border-dashed border-foreground/[0.06] pointer-events-none",
					),
					h.Style({ left: `${pct}%` }),
				]),
			),
			...Arr.map(layout.bars, (bar) =>
				barView(
					h,
					bar,
					trigger.current(barTriggerId(modelId, bar.span.spanId)),
					focusedId,
					selectedId,
				),
			),
		],
	)

const body = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	inputs: FlamegraphViewInputs,
	focused: Option.Option<SpanNode>,
	layout: FlamegraphLayout,
	trigger: Trigger,
): Html => {
	const spanMs = Option.match(focused, {
		onNone: () => inputs.input.totalDurationMs,
		onSome: (span) => span.durationMs,
	})
	const ref = triggers.get(model.id) ?? { current: trigger }
	ref.current = trigger
	triggers.set(model.id, ref)
	const openTriggerId = model.tooltip.isOpen ? model.tooltip.triggerId : ""
	return h.div(
		[
			h.Class("relative overflow-x-auto"),
			h.Style({ height: px(layout.totalLanes * (ROW_HEIGHT + ROW_GAP) + HEADER_HEIGHT + 8) }),
		],
		[
			h.div(
				[h.Class("sticky top-0 z-10 flex h-10 items-end border-b bg-background/95 px-3 pb-2")],
				Arr.map(TICKS, (pct) =>
					h.div(
						[
							h.Class("absolute text-2xs font-medium text-muted-foreground"),
							h.Style({ left: `calc(${pct}% + 12px)`, transform: "translateX(-50%)" }),
						],
						[formatDuration((spanMs * pct) / 100)],
					),
				),
			),
			barsSlot(model.id, barsLayer, [
				h,
				model.id,
				layout,
				model.focusedSpanId,
				inputs.selectedSpanId,
				openTriggerId,
				ref,
			]) ?? h.div([], []),
		],
	)
}

/** `<Flamegraph>`: header, minimap while zoomed, the bars with their tooltips, the legend. */
export const view = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	inputs: FlamegraphViewInputs,
	toMessage: (message: Message) => M,
): Html => {
	if (inputs.input.rootSpans.length === 0)
		return emptyMessage(h, { className: "border p-8 text-sm" }, ["No spans found for this trace"])
	const focused = focusedSpan(model, inputs.input)
	const layout = flamegraphBars(inputs.input, Option.getOrUndefined(focused))
	const bySpanId = new Map(
		Arr.map(layout.bars, (bar) => [barTriggerId(model.id, bar.span.spanId), bar.span]),
	)
	return h.submodel({
		slotId: model.tooltip.id,
		model: model.tooltip,
		view: Tooltip.view,
		toParentMessage: (message: Tooltip.Message) => toMessage(Message.GotTooltipMessage({ message })),
		viewInputs: {
			triggerIds: [...bySpanId.keys()],
			className: "max-w-sm",
			toContent: (triggerId) => {
				const span = bySpanId.get(triggerId)
				return span === undefined
					? []
					: [
							spanTooltipContent(h, span, {
								totalDurationMs: inputs.input.totalDurationMs,
								traceStartTime: inputs.input.traceStartTime,
							}),
						]
			},
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("border"), h.OnMount(Mount.mapMessage(MountFlamegraph(), toMessage))],
					[
						header(h, focused, toMessage(Message.ClickedReset())),
						...Option.match(focused, {
							onNone: () => [],
							onSome: (span) => [minimap(h, inputs.input, span)],
						}),
						body(h, model, inputs, focused, layout, trigger),
						footer(h, inputs.input.services),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})
}

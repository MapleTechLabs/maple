import { errorState } from "@maple/views/ui/error-state"
import type { TimeFormat } from "../kit/local-time"
import * as Timeline from "@maple/web/page/traces/detail/timeline"
import type { TraceData } from "@maple/views/traces/trace-data"
import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import { view as traceFlowView } from "@maple/views/service-map/trace-flow/view"
import { button } from "@maple/views/ui/button"
import { httpSpanLabel } from "@maple/views/ui/http-span-label"
import { icon } from "@maple/views/ui/icon"
import * as TabsView from "@maple/views/ui/tabs-view"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import type { PageViewInputs } from "../kit/inputs"
import { refreshButton } from "../kit/toolbar"
import { Message } from "./message"
import type { Model } from "./model"
import { loadedTrace } from "./update"
import { anatomyStrip, httpInfoOf, rootSpanOf } from "./view-anatomy"
import * as SpanPanel from "@maple/views/traces/span-panel"
import * as LogSheetView from "../kit/log-sheet/view"
import { spanTooltip } from "./view-span-tooltip"
import { FocusSpanPanel, TrackPointer } from "./command"
import { findSpan } from "@maple/web/page/traces/detail/select"
import { traceDetailLoading, traceNotFound } from "./view-states"

// The trace detail page.

type H = HtmlBuilder<Message>

const TAB_ICONS = new Map([
	["waterfall", "MenuIcon"],
	["timeline", "FireIcon"],
	["flow", "NetworkNodesIcon"],
] as const)

/** The page title: the root span, as an HTTP label when it is one. */
const title = (h: H, trace: TraceData | undefined): ReadonlyArray<Html> => {
	const root = trace === undefined ? undefined : rootSpanOf(trace)
	if (root === undefined) return []
	return httpInfoOf(root) !== null && httpInfoOf(root) !== undefined
		? [httpSpanLabel(h, { spanName: root.spanName, spanAttributes: root.spanAttributes, spanKind: root.spanKind, className: "min-w-0 gap-3" })]
		: [h.span([h.Class("block truncate"), h.Title(root.spanName)], [root.spanName])]
}

const tabPanel = (h: H, model: Model, value: string): ReadonlyArray<Html> | undefined => {
	if (value !== model.tabs.selected) return undefined
	if (value === "timeline" && model.timeline !== null)
		return [
			h.submodel({
				slotId: "trace-timeline",
				model: model.timeline,
				view: Timeline.view,
				viewInputs: { idPrefix: "trace-timeline" },
				toParentMessage: (message: Timeline.Message) => Message.GotTimelineMessage({ message }),
			}),
		]
	if (value === "waterfall" && model.waterfall !== null)
		return [
			h.submodel({
				slotId: "trace-waterfall",
				model: model.waterfall,
				view: Waterfall.view,
				viewInputs: {},
				toParentMessage: (message: Waterfall.Message) => Message.GotWaterfallMessage({ message }),
			}),
		]
	if (value === "flow" && model.flow !== null)
		return [traceFlowView(h, model.flow.graph, model.flow.model, (message) => Message.GotFlowMessage({ message }))]
	return undefined
}

/** `TraceViewTabs`: Waterfall, Timeline and Flow over the trace (timeline by default). */
const traceViewTabs = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "trace-view-tabs",
		model: model.tabs,
		view: TabsView.view,
		viewInputs: {
			variant: "underline",
			labels: ["Waterfall", "Timeline", "Flow"],
			className: "flex flex-col h-full",
			listClassName: "shrink-0",
			panelClassName: "flex-1 min-h-0",
			tabContent: (value: string, label: string) => [
				icon(h, TAB_ICONS.get(value === "waterfall" || value === "flow" ? value : "timeline") ?? "FireIcon", { size: 14 }),
				label,
			],
			panel: (value: string) => tabPanel(h, model, value),
		},
		toParentMessage: (message) => Message.GotTabsMessage({ message }),
	})

const loadedBody = (h: H, model: Model, trace: TraceData, timeFormat: TimeFormat): Html =>
	h.div(
		[h.Class("flex h-full min-h-0")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col")],
				[
					h.div([h.Class("shrink-0 border-b px-4 py-3")], [anatomyStrip(h, trace)]),
					h.div([h.Class("min-h-0 flex-1")], [traceViewTabs(h, model)]),
				],
			),
			...(model.panel === null ? [] : [spanPanel(h, model.panel, timeFormat)]),
			...Option.match(model.maybeLogSheet, {
				onNone: () => [],
				onSome: (sheet) => [
					h.submodel({
						slotId: "span-log-sheet",
						model: sheet,
						view: LogSheetView.view,
						viewInputs: { timeFormat },
						toParentMessage: (message) => Message.GotLogSheetMessage({ message }),
					}),
				],
			}),
		],
	)

/** The shared span panel beside the trace; it takes focus when deep-linked so Escape closes it. */
const spanPanel = (h: H, panel: SpanPanel.Model, timeFormat: TimeFormat): Html =>
	h.aside(
		[
			h.Tabindex(-1),
			h.OnMount(FocusSpanPanel()),
			h.Class("flex h-full w-full shrink-0 flex-col overflow-hidden border-l focus:outline-none sm:w-[28rem]"),
		],
		[
			h.submodel({
				slotId: "span-panel",
				model: panel,
				view: SpanPanel.view,
				viewInputs: { timeZone: timeFormat.timeZone, canFilterAttributes: false },
				toParentMessage: (message: SpanPanel.Message) => Message.GotSpanPanelMessage({ message }),
			}),
		],
	)

/** The timeline's span tooltip, while a row is hovered and the pointer has moved over the page. */
const hoverTooltip = (h: H, model: Model, trace: TraceData | undefined): ReadonlyArray<Html> => {
	const hoveredId = model.timeline?.hoveredSpanId ?? null
	if (trace === undefined || hoveredId === null || model.pointer === null) return []
	const span = findSpan(trace.rootSpans, hoveredId)
	return span === undefined
		? []
		: [
				spanTooltip(h, {
					span,
					pointer: model.pointer,
					totalDurationMs: trace.totalDurationMs,
					traceStartTime: trace.traceStartTime ?? "",
				}),
			]
}

const body = (h: H, model: Model, timeFormat: TimeFormat): Html => {
	if (isAwaitingFirstData(model.trace)) return traceDetailLoading(h)
	const failure = failureWithoutData(model.trace)
	if (Option.isSome(failure))
		return errorState(h, {
			failure: failure.value, title: "Couldn’t load trace",
			onRetry: Message.ClickedRefresh(),
		})
	return Option.match(loadedTrace(model), {
		onNone: () => traceNotFound(h, model.traceId),
		onSome: (trace) => loadedBody(h, model, trace, timeFormat),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const trace = Option.getOrUndefined(loadedTrace(model))
	return h.div(
		[
			h.Class("flex h-full flex-col"),
			h.OnMount(TrackPointer()),
			h.OnKeyDownPreventDefault((key) => (key === "Escape" && model.panel !== null ? Option.some(Message.PressedEscape()) : Option.none())),
		],
		[
			h.div(
				[h.Class("flex shrink-0 items-center gap-3 border-b px-4 py-2")],
				[
					button(h, { variant: "ghost", size: "sm", className: "shrink-0 gap-1.5", attributes: [h.OnClick(Message.ClickedBack())] }, [
						icon(h, "ArrowLeftIcon"),
						inputs.context.canGoBack ? "Back" : "Traces",
					]),
					h.div([h.Class("min-w-0 flex-1 text-sm font-semibold")], title(h, trace)),
					refreshButton(h, {
						isSpinning: model.isRefreshing,
						hasNewData: inputs.hasNewDataSince(model.traceUpdatedAtMs),
						onRefresh: Message.ClickedRefresh(),
						className: "shrink-0",
					}),
				],
			),
			h.div([h.Class("min-h-0 flex-1")], [body(h, model, inputs.context.timeFormat)]),
			...hoverTooltip(h, model, trace),
		],
	)
})


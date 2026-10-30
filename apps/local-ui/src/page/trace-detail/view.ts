import type { TimeFormat } from "../kit/local-time"
import type { TraceData } from "@maple/web/page/traces/detail/trace-data"
import { view as traceFlowView } from "@maple/web/service-map/trace-flow/view"
import { button } from "@maple/web/ui/button"
import { httpSpanLabel } from "@maple/web/ui/http-span-label"
import { icon } from "@maple/web/ui/icon"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import type { PageContext } from "../contract"
import { refreshButton } from "../kit/toolbar"
import { errorState } from "../kit/view-states"
import { Message } from "./message"
import type { Model } from "./model"
import { loadedTrace } from "./update"
import { anatomyStrip, httpInfoOf, rootSpanOf } from "./view-anatomy"
import { spanPanel } from "./view-panel"
import { spanTooltip } from "./view-span-tooltip"
import { TrackPointer } from "./command"
import {
	TabsBinding,
	TimelineBinding,
	TraceDetailComposition,
	type TraceDetailViewBuilder,
	WaterfallBinding,
} from "./composition"
import { findSpan } from "@maple/web/page/traces/detail/select"
import { traceDetailLoading, traceNotFound } from "./view-states"

// The trace detail page.

type H = TraceDetailViewBuilder

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type TraceDetailViewInputs = Readonly<{
	context: PageContext
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the trace loaded. */
const hasNewDataSince = (inputs: TraceDetailViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

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
		? [
				httpSpanLabel(h, {
					spanName: root.spanName,
					spanAttributes: root.spanAttributes,
					spanKind: root.spanKind,
					className: "min-w-0 gap-3",
				}),
			]
		: [h.span([h.Class("block truncate"), h.Title(root.spanName)], [root.spanName])]
}

const tabPanel = (h: H, model: Model, value: string): ReadonlyArray<Html> | undefined => {
	if (value !== model.tabs.selected) return undefined
	if (value === "timeline" && Option.isSome(model.timeline))
		return [
			h.block(
				TimelineBinding.embedView({
					slotId: "trace-timeline",
					model: model.timeline.value,
					viewInputs: { idPrefix: "trace-timeline" },
				}),
			),
		]
	if (value === "waterfall" && Option.isSome(model.waterfall))
		return [
			h.block(WaterfallBinding.embedView({ slotId: "trace-waterfall", model: model.waterfall.value })),
		]
	if (value === "flow" && model.flow !== null)
		return [
			traceFlowView(h, model.flow.graph, model.flow.model, (message) =>
				Message.ReceivedFlowMessage({ message }),
			),
		]
	return undefined
}

/** `TraceViewTabs`: Waterfall, Timeline and Flow over the trace (timeline by default). */
const traceViewTabs = (h: H, model: Model): Html =>
	h.block(
		TabsBinding.embedView({
			slotId: "trace-view-tabs",
			model: model.tabs,
			viewInputs: {
				variant: "underline",
				labels: ["Waterfall", "Timeline", "Flow"],
				className: "flex flex-col h-full",
				listClassName: "shrink-0",
				panelClassName: "flex-1 min-h-0",
				tabContent: (value: string, label: string) => [
					icon(
						h,
						TAB_ICONS.get(value === "waterfall" || value === "flow" ? value : "timeline") ??
							"FireIcon",
						{ size: 14 },
					),
					label,
				],
				panel: (value: string) => tabPanel(h, model, value),
			},
		}),
	)

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
			...(model.panel === null
				? []
				: [
						spanPanel(h, model, model.panel, {
							traceStartTime: trace.traceStartTime ?? "",
							totalDurationMs: trace.totalDurationMs,
							nowMs: model.traceUpdatedAtMs,
							timeFormat,
						}),
					]),
		],
	)

/** The timeline's span tooltip, while a row is hovered and the pointer has moved over the page. */
const hoverTooltip = (h: H, model: Model, trace: TraceData | undefined): ReadonlyArray<Html> => {
	const hoveredId = Option.match(model.timeline, {
		onNone: () => null,
		onSome: (timeline) => timeline.hoveredSpanId,
	})
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
	if (isPending(model.trace)) return traceDetailLoading(h)
	const failure = failureWithoutData(model.trace)
	if (Option.isSome(failure))
		return errorState(h, { label: "trace", failure: failure.value, onRetry: Message.ClickedRefresh() })
	return Option.match(loadedTrace(model), {
		onNone: () => traceNotFound(h, model.traceId),
		onSome: (trace) => loadedBody(h, model, trace, timeFormat),
	})
}

export const view = TraceDetailComposition.makeView.withInputs<TraceDetailViewInputs>((model, inputs, h) => {
	const trace = Option.getOrUndefined(loadedTrace(model))
	return h.div(
		[
			h.Class("flex h-full flex-col"),
			h.OnMount(TrackPointer()),
			h.OnKeyDownPreventDefault((key) =>
				key === "Escape" && model.panel !== null
					? Option.some(Message.PressedEscape())
					: Option.none(),
			),
		],
		[
			h.div(
				[h.Class("flex shrink-0 items-center gap-3 border-b px-4 py-2")],
				[
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							className: "shrink-0 gap-1.5",
							attributes: [h.OnClick(Message.ClickedBack())],
						},
						[icon(h, "ArrowLeftIcon"), inputs.context.canGoBack ? "Back" : "Traces"],
					),
					h.div([h.Class("min-w-0 flex-1 text-sm font-semibold")], title(h, trace)),
					refreshButton(h, {
						isSpinning: model.isRefreshing,
						hasNewData: hasNewDataSince(inputs, model.traceUpdatedAtMs),
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

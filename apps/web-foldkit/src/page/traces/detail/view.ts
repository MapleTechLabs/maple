import { shortId } from "@maple/ui/lib/ids"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { view as traceFlowView } from "../../../service-map/trace-flow/view"
import { errorState } from "../../../ui/error-state"
import { icon, type IconName } from "../../../ui/icon"
import * as Resizable from "../../../ui/resizable"
import type * as Tabs from "../../../ui/tabs"
import * as TabsView from "../../../ui/tabs-view"
import type { PageViewInputs } from "../../contract"
import type { BreadcrumbEntry } from "../../../shell"
import { dashboardPage } from "../../kit/dashboard-page"
import { decodeTraceId } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { type LoadedTrace, loadedTrace, selectedSpanOf } from "./select"
import * as SpanPanel from "./span-panel"
import { MeasureSplit } from "./split"
import * as Timeline from "./timeline"
import { headerActions, titleContent } from "./view-header"
import { errorCallout, productEvents, traceErrors } from "./view-findings"
import { detailLoading, traceNotFound } from "./view-states"
import { anatomyStrip } from "./view-summary"
import * as Waterfall from "./waterfall"

// `TraceDetailPage` (apps/web/src/routes/traces/$traceId.tsx) on `ResultPage`.

const BACK_TO_TRACES = "/traces"

/** `ResultPage`'s crumb: the short id once loaded, else the state it is in. */
export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => {
	const crumb = Option.isNone(decodeTraceId(model.traceId))
		? "Not found"
		: AsyncData.matchData(model.hierarchy.data, {
				onEmpty: () => "Loading…",
				onFailure: () => "Error",
				onData: () =>
					Option.isSome(loadedTrace(model)) ? shortId(model.traceId, "trace") : "Not found",
			})
	return [{ label: "Traces", href: BACK_TO_TRACES }, { label: crumb }]
}

const TAB_ICON = new Map<string, IconName>([
	["waterfall", "MenuIcon"],
	["timeline", "FireIcon"],
	["flow", "NetworkNodesIcon"],
])

export const tabPanel = (h: HtmlBuilder<Message>, model: Model, value: string) => {
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
		return [
			traceFlowView(h, model.flow.graph, model.flow.model, (message) =>
				Message.GotFlowMessage({ message }),
			),
		]
	return undefined
}

export const traceViewTabs = (h: HtmlBuilder<Message>, model: Model): Html =>
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
				icon(h, TAB_ICON.get(value) ?? "MenuIcon", { size: 14 }),
				label,
			],
			panel: (value: string) => tabPanel(h, model, value),
		},
		toParentMessage: (message: Tabs.Message) => Message.GotTabsMessage({ message }),
	})

/** The strip and the error callout depend on the trace and selection only, not on tab traffic. */
const anatomySlot = createLazy()
const calloutSlot = createLazy()

export const anatomy = (h: HtmlBuilder<Message>, trace: LoadedTrace, timeZone: string, nowMs: number): Html =>
	anatomyStrip(h, {
		trace,
		hasError: traceErrors(trace.data.rootSpans).spans.length > 0,
		timeZone,
		nowMs,
	})

export const callout = (
	h: HtmlBuilder<Message>,
	trace: LoadedTrace,
	selectedSpanId: string | undefined,
): Html => errorCallout(h, traceErrors(trace.data.rootSpans), selectedSpanId)

const body = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, trace: LoadedTrace): Html => {
	const selected = selectedSpanOf(model)
	const panel = model.spanPanel
	return h.div(
		[h.Class("flex flex-1 flex-col gap-y-3 min-h-0"), h.OnMount(MeasureSplit())],
		[
			anatomySlot(anatomy, [h, trace, inputs.context.timeZone, model.nowMs]),
			calloutSlot(callout, [h, trace, selected?.spanId]),
			productEvents(
				h,
				Option.getOrElse(AsyncData.getData(model.productEvents.data), () => []),
			),
			h.submodel({
				slotId: "trace-split",
				model: model.split,
				view: Resizable.view,
				viewInputs: {
					className: "flex-1 min-h-0 rounded-md border overflow-hidden",
					withHandle: [true],
					toPanels: () => [
						[traceViewTabs(h, model)],
						...(panel === null || selected === undefined
							? []
							: [
									[
										h.submodel({
											slotId: `span-panel:${selected.spanId}`,
											model: panel,
											view: SpanPanel.view,
											viewInputs: { timeZone: inputs.context.timeZone },
											toParentMessage: (message: SpanPanel.Message) =>
												Message.GotSpanPanelMessage({ message }),
										}),
									],
								]),
					],
				},
				toParentMessage: (message: Resizable.Message) => Message.GotSplitMessage({ message }),
			}),
		],
	)
}

const pageBody = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html => {
	if (Option.isNone(decodeTraceId(model.traceId)))
		return traceNotFound(h, model.traceId, BACK_TO_TRACES, {
			title: "Trace not found",
			description: "This is not a valid trace ID. Check that the link was copied in full.",
		})
	return AsyncData.matchData(model.hierarchy.data, {
		onEmpty: () => detailLoading(h),
		onFailure: (failure) => errorState(h, { failure, title: "Failed to load trace details" }),
		onData: () =>
			Option.match(loadedTrace(model), {
				onNone: () =>
					traceNotFound(h, model.traceId, BACK_TO_TRACES, {
						title: "Trace not found",
						description:
							"This trace could not be found. It may have expired or not been ingested yet.",
						hasRetentionLink: true,
					}),
				onSome: (trace) =>
					trace.rootSpan === undefined
						? traceNotFound(h, model.traceId, BACK_TO_TRACES, {
								title: "Root span missing",
								description:
									"This trace contains spans but the root span was not found. It may not have been ingested yet or could have been dropped during sampling.",
							})
						: body(h, model, inputs, trace),
			}),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const trace = Option.getOrUndefined(loadedTrace(model))
	return dashboardPage(
		h,
		{
			titleContent: trace === undefined ? undefined : titleContent(h, trace),
			actions: trace === undefined ? undefined : headerActions(h, model, trace),
		},
		[pageBody(h, model, inputs)],
	)
})

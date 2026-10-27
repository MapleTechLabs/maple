import { shortId } from "@maple/ui/lib/ids"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { view as traceFlowView } from "../../../service-map/trace-flow/view"
import type * as TraceFlow from "../../../service-map/trace-flow/trace-flow"
import { errorState } from "../../../ui/error-state"
import { icon, type IconName } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { traceIdBadge } from "../../../ui/trace-badges"
import type * as Dialog from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import * as Resizable from "../../../ui/resizable"
import type * as Tabs from "../../../ui/tabs"
import * as TabsView from "../../../ui/tabs-view"
import type { PageViewInputs } from "../../contract"
import type { BreadcrumbEntry } from "../../../shell"
import { dashboardPage } from "../../kit/dashboard-page"
import { decodeTraceId } from "./command"
import { backToTracesHref } from "./list-query"
import { Message } from "./message"
import type { Model } from "./model"
import { type LoadedTrace, loadedTrace, selectedSpanOf } from "./select"
import * as SpanPanel from "./span-panel"
import { MeasureSplit } from "./split"
import { spanSheetOf } from "./update"
import type { TraceData } from "./trace-data"
import * as Timeline from "./timeline"
import { headerActions, titleContent } from "./view-header"
import { errorCallout, productEvents, traceErrors } from "./view-findings"
import { detailLoading, traceNotFound } from "./view-states"
import { anatomyStrip } from "./view-summary"
import * as Waterfall from "./waterfall"

// The trace detail page on `ResultPage`.

/** `ResultPage`'s crumb: the short id once loaded or failed, else the state it is in. */
export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => {
	const crumb = Option.isNone(decodeTraceId(model.traceId))
		? "Not found"
		: AsyncData.matchData(model.hierarchy.data, {
				onEmpty: () => "Loading…",
				onFailure: () => shortId(model.traceId, "trace"),
				onData: () =>
					Option.isSome(loadedTrace(model)) ? shortId(model.traceId, "trace") : "Not found",
			})
	return [{ label: "Traces", href: backToTracesHref(model.listQuery) }, { label: crumb }]
}

const TAB_ICON = new Map<string, IconName>([
	["waterfall", "MenuIcon"],
	["timeline", "FireIcon"],
	["flow", "NetworkNodesIcon"],
])

/** Module-level so the flow view's lazy layers see the same function every render. */
const toFlow = (message: TraceFlow.Message) => Message.GotFlowMessage({ message })

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
		return [traceFlowView(h, model.flow.graph, model.flow.model, toFlow)]
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

// The slots key on the model's `TraceData`: `selectTrace` wraps it in a new `LoadedTrace` every render.
const lazyAnatomy = (
	h: HtmlBuilder<Message>,
	data: TraceData,
	traceStartTime: string,
	timeZone: string,
	nowMs: number,
): Html => anatomy(h, { data, traceStartTime, rootSpan: data.rootSpans[0] }, timeZone, nowMs)

const lazyCallout = (h: HtmlBuilder<Message>, data: TraceData, selectedSpanId: string | undefined): Html =>
	errorCallout(h, traceErrors(data.rootSpans), selectedSpanId)

const spanPanelView = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html | null => {
	const selected = selectedSpanOf(model)
	const panel = model.spanPanel
	return panel === null || selected === undefined
		? null
		: h.submodel({
				slotId: `span-panel:${selected.spanId}`,
				model: panel,
				view: SpanPanel.view,
				viewInputs: { timeZone: inputs.context.timeZone },
				toParentMessage: (message: SpanPanel.Message) => Message.GotSpanPanelMessage({ message }),
			})
}

/** Below `md` the trace takes the full width and the span floats over it in a bottom sheet. */
const mobileSplit = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): ReadonlyArray<Html> => {
	const sheet = spanSheetOf(model)
	return [
		h.div([h.Class("flex-1 min-h-0 rounded-md border overflow-hidden")], [traceViewTabs(h, model)]),
		h.submodel({
			slotId: "trace-span-sheet",
			model: sheet,
			view: DialogView.view,
			viewInputs: {
				className: "h-[80svh] p-0",
				side: "bottom",
				hasTrigger: false,
				showCloseButton: false,
				hasDescription: true,
				toView: ({ portal }) => portal,
				toContent: () => [
					DialogView.dialogHeader(
						h,
						"sheet",
						[
							DialogView.dialogTitle(h, "sheet", sheet.id, "Span details"),
							DialogView.dialogDescription(
								h,
								"sheet",
								sheet.id,
								"Details for the selected span.",
							),
						],
						"sr-only",
					),
					spanPanelView(h, model, inputs),
				],
			},
			toParentMessage: (message: Dialog.Message) => Message.GotSpanSheetMessage({ message }),
		}),
	]
}

const desktopSplit = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html => {
	const panel = spanPanelView(h, model, inputs)
	return h.submodel({
		slotId: "trace-split",
		model: model.split,
		view: Resizable.view,
		viewInputs: {
			className: "flex-1 min-h-0 rounded-md border overflow-hidden",
			withHandle: [true],
			toPanels: () => [[traceViewTabs(h, model)], ...(panel === null ? [] : [[panel]])],
		},
		toParentMessage: (message: Resizable.Message) => Message.GotSplitMessage({ message }),
	})
}

const body = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, trace: LoadedTrace): Html => {
	const selected = selectedSpanOf(model)
	return h.div(
		[h.Class("flex flex-1 flex-col gap-y-3 min-h-0"), h.OnMount(MeasureSplit())],
		[
			anatomySlot(lazyAnatomy, [
				h,
				trace.data,
				trace.traceStartTime,
				inputs.context.timeZone,
				model.nowMs,
			]),
			calloutSlot(lazyCallout, [h, trace.data, selected?.spanId]),
			productEvents(
				h,
				Option.getOrElse(AsyncData.getData(model.productEvents.data), () => []),
			),
			...(inputs.isMobile === true ? mobileSplit(h, model, inputs) : [desktopSplit(h, model, inputs)]),
		],
	)
}

const pageBody = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html => {
	const backHref = backToTracesHref(model.listQuery)
	if (Option.isNone(decodeTraceId(model.traceId)))
		return traceNotFound(h, model.traceId, backHref, {
			title: "Trace not found",
			description: "This is not a valid trace ID. Check that the link was copied in full.",
		})
	return AsyncData.matchData(model.hierarchy.data, {
		onEmpty: () => detailLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load trace details",
				onRetry: Message.ClickedRetryHierarchy(),
			}),
		onData: () =>
			Option.match(loadedTrace(model), {
				onNone: () =>
					traceNotFound(h, model.traceId, backHref, {
						title: "Trace not found",
						description:
							"This trace could not be found. It may have expired or not been ingested yet.",
						hasRetentionLink: true,
					}),
				onSome: (trace) =>
					trace.rootSpan === undefined
						? traceNotFound(h, model.traceId, backHref, {
								title: "Root span missing",
								description:
									"This trace contains spans but the root span was not found. It may not have been ingested yet or could have been dropped during sampling.",
							})
						: body(h, model, inputs, trace),
			}),
	})
}

/** A failed load shows the full id once, as a copy chip; the failure card owns the retry. */
const failedHeaderActions = (h: HtmlBuilder<Message>, model: Model): Html =>
	traceIdBadge(h, model.traceId, {
		size: "sm",
		className: "max-w-[260px]",
		onCopy: Message.ClickedCopyTraceId(),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const trace = Option.getOrUndefined(loadedTrace(model))
	return dashboardPage(
		h,
		{
			// A failed load still gets a header naming the trace, so the error sits under a title.
			titleContent:
				trace !== undefined
					? titleContent(h, trace)
					: AsyncData.isFailure(model.hierarchy.data)
						? pageTitle(h, { title: model.traceId, className: "leading-8" }, ["Trace"])
						: undefined,
			actions:
				trace !== undefined
					? headerActions(h, model, trace)
					: AsyncData.isFailure(model.hierarchy.data)
						? failedHeaderActions(h, model)
						: undefined,
		},
		[pageBody(h, model, inputs)],
	)
})

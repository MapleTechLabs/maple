import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as SpanPanel from "../../page/traces/detail/span-panel"
import { spanEventsSection } from "../../page/traces/detail/span-panel/events"
import type { SpanEventData } from "../../page/traces/detail/span-panel/model"
import * as Timeline from "../../page/traces/detail/timeline"
import * as Waterfall from "../../page/traces/detail/waterfall"
import { view as traceFlowView } from "../../service-map/trace-flow/view"
import { icon, type IconName } from "../../ui/icon"
import type * as Tabs from "../../ui/tabs"
import * as TabsView from "../../ui/tabs-view"
import { eventsOf, LAB_FLOW_GRAPH, Message, type Model } from "./model"

type H = HtmlBuilder<Message>

const TAB_ICON = new Map<string, IconName>([
	["waterfall", "MenuIcon"],
	["timeline", "FireIcon"],
	["flow", "NetworkNodesIcon"],
])

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
	const flow = model.flow
	if (value === "flow" && flow !== null)
		return Option.match(LAB_FLOW_GRAPH, {
			onNone: () => undefined,
			onSome: (graph) => [
				traceFlowView(h, graph, flow, (message) => Message.GotFlowMessage({ message })),
			],
		})
	return undefined
}

/** `TraceViewTabs`: underline tabs over the active view. */
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
				icon(h, TAB_ICON.get(value) ?? "MenuIcon", { size: 14 }),
				label,
			],
			panel: (value: string) => tabPanel(h, model, value),
		},
		toParentMessage: (message: Tabs.Message) => Message.GotTabsMessage({ message }),
	})

const eventsView = Submodel.defineView<
	SpanPanel.Model,
	SpanPanel.Message,
	Readonly<{ events: ReadonlyArray<SpanEventData> }>
>((panel, inputs, h) => spanEventsSection(h, panel, inputs.events) ?? h.empty)

/** `SpanEventsSection` in a side column, for a selected span that has events. */
const eventsAside = (h: H, model: Model): ReadonlyArray<Html> => {
	const events = model.selectedSpanId === null ? [] : eventsOf(model.selectedSpanId)
	return model.panel === null || events.length === 0
		? []
		: [
				h.aside(
					[h.Class("w-96 shrink-0 overflow-y-auto")],
					[
						h.submodel({
							slotId: "timeline-lab-events",
							model: model.panel,
							view: eventsView,
							viewInputs: { events },
							toParentMessage: (message: SpanPanel.Message) =>
								Message.GotPanelMessage({ message }),
						}),
					],
				),
			]
}

export const view = (model: Model, h: H): Html =>
	h.div(
		[h.Class("flex h-screen gap-4 p-4")],
		[h.div([h.Class("min-w-0 flex-1")], [traceViewTabs(h, model)]), ...eventsAside(h, model)],
	)

import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Timeline from "../../page/traces/detail/timeline"
import * as Waterfall from "../../page/traces/detail/waterfall"
import { view as traceFlowView } from "../../service-map/trace-flow/view"
import { icon, type IconName } from "../../ui/icon"
import type * as Tabs from "../../ui/tabs"
import * as TabsView from "../../ui/tabs-view"
import { flowGraphOf, Message, type Model } from "./trace-box"

// `TraceViewTabs` inside the lab's `h-[640px]` box.

type H = HtmlBuilder<Message>

const TAB_ICON = new Map<string, IconName>([
	["waterfall", "MenuIcon"],
	["timeline", "FireIcon"],
	["flow", "NetworkNodesIcon"],
])

const tabPanel = (h: H, model: Model, id: string, value: string): ReadonlyArray<Html> | undefined => {
	if (value !== model.tabs.selected) return undefined
	if (value === "timeline" && model.timeline !== null)
		return [
			h.submodel({
				slotId: "trace-timeline",
				model: model.timeline,
				view: Timeline.view,
				viewInputs: { idPrefix: `${id}-timeline` },
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
		return [
			traceFlowView(h, flowGraphOf(model.trace), flow, (message) =>
				Message.GotFlowMessage({ message }),
			),
		]
	return undefined
}

export const view = Submodel.defineView<Model, Message, Readonly<{ id: string }>>((model, inputs, h) =>
	h.div(
		[h.Class("h-[640px] rounded-md border p-2")],
		[
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
					panel: (value: string) => tabPanel(h, model, inputs.id, value),
				},
				toParentMessage: (message: Tabs.Message) => Message.GotTabsMessage({ message }),
			}),
		],
	),
)

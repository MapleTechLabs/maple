import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "../../../ui/copy-button"
import * as Tabs from "../../../ui/tabs"
import * as TabsView from "../../../ui/tabs-view"
import { defineLab } from "../../define"
import { separator } from "../../../ui/display"
import { alertSection, cardAndPanelSection, emptySection, itemSection } from "../../kit/display-sections"
import {
	keyValueSection,
	meterSection,
	skeletonSection,
	statSection,
	tableSection,
} from "../../kit/display-sections-more"
import { kitPage, kitSection } from "../../kit/kit-layout"

// `/lab/kit/display`: surfaces, data display and
// loading states. Both tab strips and the trace id copy button are live Submodels.

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"

// MODEL

const Model = Schema.Struct({
	defaultTabs: Tabs.Model,
	underlineTabs: Tabs.Model,
	traceIdCopy: CopyButton.Model,
})
type Model = typeof Model.Type

// Base UI ids in render order: the first Tabs takes `_r_0_`..`_r_3_`, the second `_r_4_`..`_r_7_`.
const init = (): Update.Return<Model, Message> => ({
	model: {
		defaultTabs: Tabs.init({ idBase: 0, values: ["overview", "traces", "logs"], selected: "overview" }),
		underlineTabs: Tabs.init({ idBase: 4, values: ["inbox", "rules", "routing"], selected: "rules" }),
		traceIdCopy: CopyButton.init(),
	},
})

// MESSAGE

const Message = defineMessageUnion({
	GotDefaultTabsMessage: { message: Tabs.Message },
	GotUnderlineTabsMessage: { message: Tabs.Message },
	GotCopyMessage: { message: CopyButton.Message },
})
type Message = typeof Message.Type

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotDefaultTabsMessage: ({ message }) => {
			const next = Tabs.update(model.defaultTabs, message)
			return {
				model: { ...model, defaultTabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotDefaultTabsMessage({ message: child }),
				),
			}
		},
		GotUnderlineTabsMessage: ({ message }) => {
			const next = Tabs.update(model.underlineTabs, message)
			return {
				model: { ...model, underlineTabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotUnderlineTabsMessage({ message: child }),
				),
			}
		},
		GotCopyMessage: ({ message }) => {
			const next = CopyButton.update(model.traceIdCopy, message)
			return {
				model: { ...model, traceIdCopy: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotCopyMessage({ message: child }),
				),
			}
		},
	})

// VIEW

const defaultTabs = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "kit-display-tabs-default",
		model: model.defaultTabs,
		toParentMessage: (message: Tabs.Message) => Message.GotDefaultTabsMessage({ message }),
		view: TabsView.view,
		viewInputs: {
			labels: ["Overview", "Traces", "Logs"],
			panelClassName: "pt-3 text-sm",
			panel: (value: string) => (value === "overview" ? ["Default tabs panel."] : undefined),
		},
	})

const underlineTabs = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "kit-display-tabs-underline",
		model: model.underlineTabs,
		toParentMessage: (message: Tabs.Message) => Message.GotUnderlineTabsMessage({ message }),
		view: TabsView.view,
		viewInputs: {
			variant: "underline",
			labels: ["Inbox", "Rules", "Routing"],
			panelClassName: "pt-3 text-sm",
			panel: (value: string) => (value === "rules" ? ["Underline tabs panel."] : undefined),
		},
	})

const tabsSection = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitSection(h, "Tabs and separator", [
		defaultTabs(model, h),
		separator(h, "horizontal", undefined),
		underlineTabs(model, h),
		h.div(
			[h.Class("flex h-6 items-center gap-3 text-sm")],
			["Left ", separator(h, "vertical", undefined), " Right"],
		),
	])

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitPage(
		h,
		{ title: "Kit: display", description: "Surfaces, data display and loading states from @maple/ui." },
		[
			cardAndPanelSection(h),
			alertSection(h),
			emptySection(h),
			itemSection(h),
			keyValueSection(
				h,
				model.traceIdCopy.status,
				Message.GotCopyMessage({ message: CopyButton.Message.ClickedCopy({ text: TRACE_ID }) }),
			),
			meterSection(h),
			statSection(h),
			skeletonSection(h),
			tableSection(h),
			tabsSection(model, h),
		],
	)

export const lab = defineLab<Model, Message>("Kit: display", { Model, init, update, view })

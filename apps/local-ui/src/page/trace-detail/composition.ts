import * as Timeline from "@maple/web/page/traces/detail/timeline"
import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import { AttachFlowCanvas } from "@maple/web/service-map/xyflow/attach"
import { AttributesPanelBlock } from "@maple/web/ui/attributes/attributes-panel-block"
import { TabsBlock } from "@maple/web/ui/tabs-view"
import { Tuple } from "effect"
import { type Block, Update } from "foldkit"
import { LogSheetBlock } from "../kit/log-sheet/block"
import { FocusSpanPanel, RelaySpanChoice, RelayTabChoice, TrackPointer } from "./command"
import { makeCommandsStep, makeFieldsStep, makeNoopStep, TraceDetailDefinition } from "./definition"
import { PANEL_ATTRIBUTES_ID, PANEL_TABS } from "./panel-model"
import { TAB_VALUES } from "./views"

// The page's children: the Waterfall / Timeline / Flow tabs and the mounted tab's Block, then the
// span panel's tabs, attributes panel and log sheet.

/** `TraceViewTabs`' tab strip, starting on the hash's `view`. */
export const TabsBinding = TraceDetailDefinition.makeBinding(TabsBlock, {
	field: "tabs",
	init: { contextToArgs: ({ view }) => Tuple.make({ idBase: 23, values: TAB_VALUES, selected: view }) },
})

/**
 * The hash owns the tab: a press goes back to the tab it left, and the relayed choice navigates.
 * The navigation's location change then enters the new tab.
 */
const TabsBindingWithOutMessagePolicy = TabsBinding.withOutMessagePolicy({
	fold: TraceDetailDefinition.makeOutMessageFold(TabsBlock, {
		ChangedSelection: ({ value }, { modelBeforeUpdate }) =>
			Update.combineSteps([
				TabsBinding.informOfSelection({ value: modelBeforeUpdate.tabs.selected }),
				makeCommandsStep(() => [RelayTabChoice({ value })]),
			]),
	}),
})

/** The Timeline tab, while it is the mounted one. */
export const TimelineBinding = TraceDetailDefinition.makeBinding(Timeline.TimelineBlock, {
	field: "timeline",
})

const TimelineBindingWithOutMessagePolicy = TimelineBinding.withOutMessagePolicy({
	fold: TraceDetailDefinition.makeOutMessageFold(Timeline.TimelineBlock, {
		SelectedSpan: ({ spanId }) => makeCommandsStep(() => [RelaySpanChoice({ spanId })]),
		ChangedColorBy: ({ colorBy }) =>
			Update.combineSteps([
				makeFieldsStep(() => ({ colorBy: () => colorBy })),
				TimelineBinding.informColorBy({ colorBy }),
			]),
	}),
})

/** The Waterfall tab, while it is the mounted one. */
export const WaterfallBinding = TraceDetailDefinition.makeBinding(Waterfall.WaterfallBlock, {
	field: "waterfall",
}).withOutMessagePolicy({
	fold: TraceDetailDefinition.makeOutMessageFold(Waterfall.WaterfallBlock, {
		SelectedSpan: ({ spanId }) => makeCommandsStep(() => [RelaySpanChoice({ spanId })]),
	}),
})

/** The span panel's Details / Logs tabs; nothing navigates on a press. */
export const PanelTabsBinding = TraceDetailDefinition.makeBinding(TabsBlock, {
	field: "panelTabs",
	init: { contextToArgs: () => Tuple.make({ idBase: 40, values: PANEL_TABS, selected: "details" }) },
}).withOutMessagePolicy({
	fold: TraceDetailDefinition.makeOutMessageFold(TabsBlock, { ChangedSelection: makeNoopStep }),
})

/** The local panel has no attribute filters, so the filter OutMessage is never raised. */
export const PanelAttributesBinding = TraceDetailDefinition.makeBinding(AttributesPanelBlock, {
	field: "panelAttributes",
	init: { contextToArgs: () => Tuple.make(PANEL_ATTRIBUTES_ID) },
}).withOutMessagePolicy({
	fold: TraceDetailDefinition.makeOutMessageFold(AttributesPanelBlock, {
		ChoseAttributeFilter: makeNoopStep,
	}),
})

/** `SpanLogs`' log sheet, once a row was opened. */
export const LogSheetBinding = TraceDetailDefinition.makeBinding(LogSheetBlock, { field: "panelLogSheet" })

export const TraceDetailComposition = TraceDetailDefinition.makeComposition({
	bindings: [
		TabsBindingWithOutMessagePolicy,
		TimelineBindingWithOutMessagePolicy,
		WaterfallBinding,
		PanelTabsBinding,
		PanelAttributesBinding,
		LogSheetBinding,
	],
	mounts: [FocusSpanPanel, TrackPointer, AttachFlowCanvas],
})
export type TraceDetailViewBuilder = Block.ViewBuilderFor<typeof TraceDetailComposition>

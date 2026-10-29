import { Tuple } from "effect"
import type { Block } from "foldkit"
import { MountNetworkAutoRetry } from "../../../../ui/error-state"
import { TabsBlock } from "../../../../ui/tabs-view"
import { InfraCorrelationBlock } from "../../../kit/infra-correlation"
import { makeNoopStep, SpanPanelDefinition } from "./definition"

// The panel's children: its Details / Logs / Infrastructure tabs and the Infrastructure tab's panel.

export const TAB_VALUES = ["details", "logs", "infrastructure"] as const

/** The panel stays on the selected tab; the tab strip asks nothing else of it. */
export const TabsBinding = SpanPanelDefinition.makeBinding(TabsBlock, {
	field: "tabs",
	init: { contextToArgs: () => Tuple.make({ idBase: 32, values: TAB_VALUES, selected: "details" }) },
}).withOutMessagePolicy({
	fold: SpanPanelDefinition.makeOutMessageFold(TabsBlock, { ChangedSelection: makeNoopStep }),
})

/** The panel's init writes `infra` itself: its id and org come from the selected span. */
export const InfraBinding = SpanPanelDefinition.makeBinding(InfraCorrelationBlock, {
	field: "infra",
	init: false,
})

export const SpanPanelComposition = SpanPanelDefinition.makeComposition({
	bindings: [TabsBinding, InfraBinding],
	mounts: [MountNetworkAutoRetry],
})
export type SpanPanelViewBuilder = Block.ViewBuilderFor<typeof SpanPanelComposition>

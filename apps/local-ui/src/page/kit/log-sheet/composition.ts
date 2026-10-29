import { AttributesPanelBlock } from "@maple/web/ui/attributes/attributes-panel-block"
import { DialogBlock } from "@maple/web/ui/dialog-view"
import { TabsBlock } from "@maple/web/ui/tabs-view"
import { TooltipBlock } from "@maple/web/ui/tooltip"
import { Tuple } from "effect"
import { Block } from "foldkit"
import { LogSheetDefinition, makeNoopStep } from "./definition"
import { ATTRIBUTES_ID, SHEET_ID, TABS_ID_BASE, TOOLTIP_ID, tabValuesOf } from "./model"

// The sheet's children: the kit's Sheet dialog, its tabs, the attributes panel and the copy buttons' one Tooltip.

export const DialogBinding = LogSheetDefinition.makeBinding(DialogBlock, {
	field: "dialog",
	init: { contextToArgs: () => Tuple.make(SHEET_ID, "sheet") },
}).withOutMessagePolicy({
	fold: LogSheetDefinition.makeOutMessageFold(DialogBlock, { Opened: makeNoopStep, Closed: makeNoopStep }),
})

export const TabsBinding = LogSheetDefinition.makeBinding(TabsBlock, {
	field: "tabs",
	init: {
		contextToArgs: ({ log }) =>
			Tuple.make({ idBase: TABS_ID_BASE, values: tabValuesOf(log), selected: "attributes" }),
	},
}).withOutMessagePolicy({
	fold: LogSheetDefinition.makeOutMessageFold(TabsBlock, { ChangedSelection: makeNoopStep }),
})

/** The local sheet has no attribute filters, so the panel's filter OutMessage is never raised. */
export const AttributesBinding = LogSheetDefinition.makeBinding(AttributesPanelBlock, {
	field: "attributes",
	init: { contextToArgs: () => Tuple.make(ATTRIBUTES_ID) },
}).withOutMessagePolicy({
	fold: LogSheetDefinition.makeOutMessageFold(AttributesPanelBlock, { ChoseAttributeFilter: makeNoopStep }),
})

export const TooltipBinding = LogSheetDefinition.makeBinding(TooltipBlock, {
	field: "tooltip",
	init: { contextToArgs: () => Tuple.make(TOOLTIP_ID) },
})

export const LogSheetComposition = LogSheetDefinition.makeComposition({
	bindings: [DialogBinding, TabsBinding, AttributesBinding, TooltipBinding],
})
export type LogSheetViewBuilder = Block.ViewBuilderFor<typeof LogSheetComposition>

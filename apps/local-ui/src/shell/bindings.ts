import { DialogBlock } from "@maple/web/ui/dialog-view"
import * as Popover from "@maple/web/ui/popover"
import { TabsBlock } from "@maple/web/ui/tabs-view"
import { Tuple } from "effect"
import { INSTALL_METHODS } from "../lib/links"
import type { Model } from "../model"
import { ApplicationDefinition } from "../page/application-definition"
import { FILTER_DRAWER_ID } from "../page/kit/page-shell"

// The shell's children on the root: the connect popover, the install tabs and the Filters drawer.
// Register all three in the root Composition; none needs a root-specific policy.

const { makeStep, makeNoopStep } = ApplicationDefinition

export const CONNECT_POPOVER_ID = "connect"

/** `ConnectButton`'s popover. */
export const ConnectPopoverBinding = ApplicationDefinition.makeBinding(Popover.PopoverBlock, {
	field: "connect",
	init: {
		contextToArgs: () =>
			Tuple.make(CONNECT_POPOVER_ID, { side: "right", align: "end", initialFocus: "first-tabbable" }),
	},
})

/** `InstallCommands` on the disconnected screen. */
export const InstallTabsBinding = ApplicationDefinition.makeBinding(TabsBlock, {
	field: "installTabs",
	init: {
		contextToArgs: () =>
			Tuple.make({
				idBase: 0,
				values: INSTALL_METHODS.map((method) => method.id),
				selected: INSTALL_METHODS[0]?.id ?? "",
			}),
	},
}).withOutMessagePolicy({
	fold: ApplicationDefinition.makeOutMessageFold(TabsBlock, { ChangedSelection: makeNoopStep }),
})

/** `PageShell`'s Filters drawer below `md`. */
export const FilterDrawerBinding = ApplicationDefinition.makeBinding(DialogBlock, {
	field: "filterDrawer",
	init: { contextToArgs: () => Tuple.make(FILTER_DRAWER_ID, "sheet") },
}).withOutMessagePolicy({
	fold: ApplicationDefinition.makeOutMessageFold(DialogBlock, {
		Opened: makeNoopStep,
		Closed: makeNoopStep,
	}),
})

/** The page's Filters button: open the drawer. */
export const openFilterDrawerStep = FilterDrawerBinding.requestOpen()

/** A new page starts the drawer closed, without a leave transition (a fresh occurrence). */
export const resetFilterDrawerStep = makeStep((model: Model) =>
	FilterDrawerBinding.init({
		args: Tuple.make(FILTER_DRAWER_ID, "sheet"),
		toParentModel: (filterDrawer) => ({ ...model, filterDrawer }),
	}),
)

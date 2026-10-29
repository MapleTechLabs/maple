import { Option, Tuple } from "effect"
import { Block, Update } from "foldkit"
import { DialogBlock } from "../ui/dialog-view"
import * as Tooltip from "../ui/tooltip"
import { ClerkOrgSwitcherBlock } from "./clerk-org-switcher-view"
import { OpenGlobalChat } from "./command"
import { ConnectPanelBlock } from "./connect-panel-view"
import { makeNoopStep, makeStep, ShellDefinition } from "./definition"
import { OutMessage } from "./message"
import type { Model } from "./model"
import { MeasureShortcutsPanel, MeasureSidebarOverflow, MountNamespaceSearch, PositionMenu } from "./mounts"
import { ChecklistBlock } from "./onboarding-checklist-view"
import type { PaletteEntry } from "./palette/entries"
import { SHORTCUTS_DIALOG_ID } from "./palette/shortcuts-view"
import { findEntry } from "./palette/update"
import { PaletteBlock } from "./palette/view"
import { SupportChannelBlock } from "./support-channel-view"
import {
	andThen,
	clickedNamespace,
	closePalette,
	connectContextOf,
	paletteContextOf,
	readNamespaces,
	toggleTheme,
} from "./update-local"

// The shell's children: the page rails' sheets, the rail tooltip, the Clerk org switcher, the top
// bar's reward pill and Connect popover, the support channel dialog, the palette and shortcuts.

/** `PageLayout.FilterSidebar` and `RightSidebar` below `lg`; their own open and close. */
export const FilterSheetBinding = ShellDefinition.makeBinding(DialogBlock, {
	field: "filterSheet",
	init: false,
}).withOutMessagePolicy({
	fold: ShellDefinition.makeOutMessageFold(DialogBlock, { Opened: makeNoopStep, Closed: makeNoopStep }),
})

export const RightSheetBinding = ShellDefinition.makeBinding(DialogBlock, {
	field: "rightSheet",
	init: false,
}).withOutMessagePolicy({
	fold: ShellDefinition.makeOutMessageFold(DialogBlock, { Opened: makeNoopStep, Closed: makeNoopStep }),
})

/** `KeyboardShortcutsDialog`: mounted on open, dropped on close, so it plays no exit transition. */
export const ShortcutsDialogBinding = ShellDefinition.makeBinding(DialogBlock, {
	field: "shortcutsDialog",
	init: false,
}).withOutMessagePolicy({
	fold: ShellDefinition.makeOutMessageFold(DialogBlock, {
		Opened: makeNoopStep,
		Closed: () => makeStep((model) => ({ model: { ...model, shortcutsDialog: Option.none() } })),
	}),
})

/** The collapsed rail's tooltips: one Tooltip shared by every rail button. */
export const RailTooltipBinding = ShellDefinition.makeBinding(Tooltip.TooltipBlock, {
	field: "railTooltip",
	init: false,
})

/** The Clerk switcher: a pick goes to the root, a namespace pins, its submenu reads the list. */
export const ClerkOrgMenuBinding = ShellDefinition.makeBinding(ClerkOrgSwitcherBlock, {
	field: "clerkOrgMenu",
	init: false,
}).withOutMessagePolicy({
	fold: ShellDefinition.makeOutMessageFold(ClerkOrgSwitcherBlock, {
		SelectedOrganization: ({ orgId }) =>
			makeStep((model) =>
				Option.contains(model.maybeOrgId, orgId)
					? { model }
					: { model, outMessage: OutMessage.RequestedOrganizationSwitch({ orgId }) },
			),
		SelectedNamespace: ({ maybeNamespace }) =>
			makeStep((model) => clickedNamespace(model, maybeNamespace)),
		OpenedNamespaces: () => makeStep(readNamespaces),
	}),
})

/** Clerk: the onboarding reward pill in the top bar. */
export const ChecklistBinding = ShellDefinition.makeBinding(ChecklistBlock, {
	field: "checklist",
	init: false,
})

/** The top bar's Connect popover; its reads apply the shell's org and namespace pin. */
export const ConnectBinding = ShellDefinition.makeBinding(ConnectPanelBlock, {
	field: "connect",
	init: false,
	delivery: { toUpdateContext: (model) => Tuple.make(connectContextOf(model)) },
})

/** Clerk: the shared Slack channel dialog of the Support menu. */
export const SupportChannelBinding = ShellDefinition.makeBinding(SupportChannelBlock, {
	field: "supportChannel",
	init: false,
})

/** The command palette, mounted while open. */
export const PaletteBinding = ShellDefinition.makeBinding(PaletteBlock, { field: "palette", init: false })

// PALETTE AND SHORTCUTS (`GlobalShortcuts`): both mount on open and unmount on close.

/** `handleShowShortcuts`'s dialog, mounted open unless it already is. */
const mountShortcutsStep = makeStep((model) =>
	Option.isSome(model.shortcutsDialog)
		? makeNoopStep()
		: makeStep(() =>
				ShortcutsDialogBinding.init({
					args: [SHORTCUTS_DIALOG_ID, "dialog", { isOpen: true }],
					toParentModel: (dialog) => ({ ...model, shortcutsDialog: Option.some(dialog) }),
				}),
			),
)

/** Mod+K, the Search row: the palette mounts (a no-op while it is open). */
export const openPaletteStep = makeStep((model) =>
	Option.isSome(model.palette)
		? makeNoopStep()
		: makeStep(() =>
				PaletteBinding.init({
					args: [],
					toParentModel: (palette) => ({ ...model, palette: Option.some(palette) }),
				}),
			),
)

/** `handleShowShortcuts`: the palette closes and the dialog opens. */
export const openShortcutsStep = Update.combineSteps([makeStep(closePalette), mountShortcutsStep])

/** A pick: links navigate, actions run; either way the palette closes. */
const pickedStep = (entry: PaletteEntry | undefined) =>
	makeStep((model) => {
		if (entry === undefined) return makeNoopStep()
		if (entry.target._tag === "Href") {
			const url = entry.target.href
			return makeStep(() => ({
				...closePalette(model),
				outMessage: OutMessage.RequestedNavigation({ url }),
			}))
		}
		switch (entry.target.action) {
			case "AskMapleAi":
				return Update.combineSteps([
					makeStep(() => ({ model, commands: [OpenGlobalChat({ isFocusVisible: true })] })),
					PaletteBinding.requestDelayedClose(),
				])
			case "ToggleTheme":
				return makeStep(() => andThen(closePalette(model), toggleTheme))
			case "ShowShortcuts":
				return Update.combineSteps([PaletteBinding.requestDelayedClose(), mountShortcutsStep])
		}
	})

const entryOf = (model: Model, id: string): PaletteEntry | undefined =>
	Option.match(model.palette, {
		onNone: () => undefined,
		onSome: (palette) => findEntry(palette, paletteContextOf(model), id),
	})

export const PaletteBindingWithOutMessagePolicy = PaletteBinding.withOutMessagePolicy({
	fold: ShellDefinition.makeOutMessageFold(PaletteBlock, {
		Closed: () => makeStep(closePalette),
		PickedEntry: ({ id }) => makeStep((model) => pickedStep(entryOf(model, id))),
		// A link's own click navigates (the root routes it), so only the palette closes.
		ClickedEntry: ({ id }) =>
			makeStep((model) => {
				const entry = entryOf(model, id)
				return entry?.target._tag === "Href" ? makeStep(closePalette) : pickedStep(entry)
			}),
	}),
})

export const ShellComposition = ShellDefinition.makeComposition({
	bindings: [
		FilterSheetBinding,
		RightSheetBinding,
		ShortcutsDialogBinding,
		RailTooltipBinding,
		ClerkOrgMenuBinding,
		ChecklistBinding,
		ConnectBinding,
		SupportChannelBinding,
		PaletteBindingWithOutMessagePolicy,
	],
	mounts: [PositionMenu, MountNamespaceSearch, MeasureSidebarOverflow, MeasureShortcutsPanel],
})
export type ShellViewBuilder = Block.ViewBuilderFor<typeof ShellComposition>

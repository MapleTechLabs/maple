import { Option } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import * as Dialog from "../ui/dialog"
import type { Resources } from "../platform/resources"
import { OpenGlobalChat, SaveTheme } from "./command"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"
import { DelayClose, ReleasePaletteServices } from "./palette/command"
import type * as PaletteModel from "./palette/model"
import { SHORTCUTS_DIALOG_ID } from "./palette/shortcuts-view"
import * as Palette from "./palette/update"

// `GlobalShortcuts`: the palette and the shortcuts dialog mount on open and unmount on close, so
// neither plays an exit transition.

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const toPalette = Command.mapMessage((message: PaletteModel.Message) =>
	Message.GotPaletteMessage({ message }),
)
const toShortcuts = Command.mapMessage((message: Dialog.Message) =>
	Message.GotShortcutsDialogMessage({ message }),
)

export const paletteContextOf = (model: Model): Palette.Context => ({
	dashboards: AsyncData.getOrElse(model.dashboards, () => []),
	favorites: model.dashboardFavorites,
	theme: model.theme,
})

export const openPalette = (model: Model): UpdateReturn => {
	if (model.palette !== null) return { model }
	const opened = Palette.open()
	return { model: { ...model, palette: opened.model }, commands: (opened.commands ?? []).map(toPalette) }
}

/** The unmount: the services read's idle TTL starts. */
export const closePalette = (model: Model): UpdateReturn =>
	model.palette === null
		? { model }
		: {
				model: { ...model, palette: null },
				commands: Option.match(model.maybeOrgId, {
					onNone: () => [],
					onSome: (orgId) => [toPalette(ReleasePaletteServices({ orgId }))],
				}),
			}

export const toggleTheme = (model: Model): UpdateReturn => {
	const theme = model.theme === "dark" ? "light" : "dark"
	return { model: { ...model, theme }, commands: [SaveTheme({ theme })] }
}

const initShortcuts = () => Dialog.init(SHORTCUTS_DIALOG_ID, "dialog", { isOpen: true })

/** `handleShowShortcuts`: the palette closes and the dialog opens. */
export const openShortcuts = (model: Model): UpdateReturn => {
	const closed = closePalette(model)
	return {
		model: {
			...closed.model,
			shortcutsDialog: closed.model.shortcutsDialog ?? initShortcuts(),
		},
		commands: closed.commands ?? [],
	}
}

const withCommands = (step: UpdateReturn, commands: UpdateReturn["commands"]): UpdateReturn => ({
	...step,
	commands: [...(commands ?? []), ...(step.commands ?? [])],
})

/** A palette step: a pick closes it, then navigates or runs its action. */
export const paletteStep = (model: Model, message: PaletteModel.Message): UpdateReturn => {
	if (model.palette === null) return { model }
	// A closing palette only waits for its delay; nothing else reaches it.
	if (model.palette.isClosing && message._tag !== "ElapsedCloseDelay") return { model }
	const next = Palette.update(model.palette, message, paletteContextOf(model))
	const stepped: Model = { ...model, palette: next.model }
	const commands = (next.commands ?? []).map(toPalette)
	const out = next.outMessage
	if (out === undefined) return { model: stepped, commands }
	const closed = withCommands(closePalette(stepped), commands)
	const closing: Model = { ...stepped, palette: { ...next.model, isClosing: true } }
	switch (out._tag) {
		case "Closed":
			return closed
		case "Navigated":
			return { ...closed, outMessage: OutMessage.RequestedNavigation({ url: out.href }) }
		case "RanAction":
			switch (out.action) {
				case "AskMapleAi":
					return {
						model: closing,
						commands: [
							...commands,
							OpenGlobalChat({ isFocusVisible: true }),
							toPalette(DelayClose()),
						],
					}
				case "ToggleTheme":
					return withCommands(toggleTheme(closed.model), closed.commands)
				case "ShowShortcuts":
					return {
						model: { ...closing, shortcutsDialog: closing.shortcutsDialog ?? initShortcuts() },
						commands: [...commands, toPalette(DelayClose())],
					}
			}
	}
}

export const shortcutsDialogStep = (model: Model, message: Dialog.Message): UpdateReturn => {
	if (model.shortcutsDialog === null) return { model }
	const next = Dialog.update(model.shortcutsDialog, message)
	return next.outMessage?._tag === "Closed"
		? { model: { ...model, shortcutsDialog: null } }
		: {
				model: { ...model, shortcutsDialog: next.model },
				commands: (next.commands ?? []).map(toShortcuts),
			}
}

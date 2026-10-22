import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as Dialog from "@maple/web/ui/dialog"
import * as Tabs from "@maple/web/ui/tabs"
import * as Tooltip from "@maple/web/ui/tooltip"
import type { Option } from "effect"
import { Command, type Update } from "foldkit"
import { updateCopy } from "../copies"
import { Message } from "./message"
import { type LocalLog, type Model, withLog } from "./model"

export type UpdateReturn = Update.Return<Model, Message>

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): UpdateReturn => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/** A row click: the sheet shows `log`, opening if it was closed. */
export const openLog = (maybeSheet: Option.Option<Model>, log: LocalLog): UpdateReturn => {
	const sheet = withLog(maybeSheet, log)
	return liftDialog(sheet, Dialog.open(sheet.dialog))
}

export const isOpen = (model: Model): boolean => model.dialog.isOpen

/** The local sheet has no attribute filters, so the panel's filter OutMessage is never raised. */
export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClosedSheet: () => liftDialog(model, Dialog.close(model.dialog)),
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		ToggledBodyExpanded: () => ({ model: { ...model, isBodyExpanded: !model.isBodyExpanded } }),
		ToggledErrorExpanded: () => ({ model: { ...model, isErrorExpanded: !model.isErrorExpanded } }),
		GotTabsMessage: ({ message: child }) => {
			const next = Tabs.update(model.tabs, child)
			return {
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tabs) =>
					Message.GotTabsMessage({ message: tabs }),
				),
			}
		},
		GotAttributesMessage: ({ message: child }) => {
			const next = AttributesPanel.update(model.attributes, child)
			return {
				model: { ...model, attributes: next.model },
				commands: Command.mapMessages(next.commands ?? [], (panel) =>
					Message.GotAttributesMessage({ message: panel }),
				),
			}
		},
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) =>
				Message.GotCopyMessage({ id: copyId, message: copyMessage }),
			)
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
		GotTooltipMessage: ({ message: child }) => {
			const next = Tooltip.update(model.tooltip, child)
			return {
				model: { ...model, tooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tooltip) =>
					Message.GotTooltipMessage({ message: tooltip }),
				),
			}
		},
	})

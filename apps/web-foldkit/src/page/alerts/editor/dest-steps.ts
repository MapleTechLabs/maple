import { AlertDestinationId, AlertDestinationType } from "@maple/domain/http"
import { chatDestinationForm, defaultDestinationForm } from "@maple/web-data/alerts/form-utils"
import { Option, Schema } from "effect"
import { Command } from "foldkit"
import * as Menu from "../../../ui/menu"
import { PageOutMessage } from "../../contract"
import * as DestinationDialog from "../destination/dialog"
import { addId, removeId, updateTierIds } from "./form-steps"
import { Message, type Tier } from "./message"
import type { Model } from "./model"
import type { Return } from "./steps"

// "Who gets notified": the Add destination menus, and the destination dialog they open. A
// destination made here is selected on the draft (`useDestinationManager({ onCreated })`).

export const menuIdOf = (tier: Tier): string => `alert-rule-add-destination-${tier}`
const tierOfMenu = (menuId: string): Tier => (menuId.endsWith("critical") ? "critical" : "warning")

const decodeType = Schema.decodeUnknownOption(AlertDestinationType)
const decodeId = Schema.decodeUnknownOption(AlertDestinationId)

export const liftDialog = (model: Model, step: ReturnType<typeof DestinationDialog.update>): Return => {
	const next: Model = { ...model, destinationDialog: step.model }
	const commands = Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDestinationDialogMessage({ message }),
	)
	if (step.outMessage === undefined) return { model: next, commands }
	return DestinationDialog.OutMessage.match(step.outMessage, {
		CreatedDestination: ({ id }) => ({
			model: next.form === null ? next : { ...next, form: updateTierIds(next.form, "warning", addId(id)) },
			commands,
			outMessage: PageOutMessage.RequestedToast({ type: "success", title: "Destination created", description: "" }),
		}),
		RequestedToast: ({ type, title, description }) => ({
			model: next,
			commands,
			outMessage: PageOutMessage.RequestedToast({ type, title, description }),
		}),
	})
}

/** A pick from a tier's menu: an existing destination, or a new one of a type (`onAddDestination`). */
const picked = (model: Model, menuId: string, value: string): Return => {
	const [kind = "", ...rest] = value.split(":")
	const tier = tierOfMenu(menuId)
	if (kind === "existing")
		return Option.match(decodeId(rest.join(":")), {
			onNone: () => ({ model }),
			onSome: (id) => ({
				model: model.form === null ? model : { ...model, form: updateTierIds(model.form, tier, addId(id)) },
			}),
		})
	if (kind === "type")
		return Option.match(decodeType(rest.join(":")), {
			onNone: () => ({ model }),
			onSome: (type) => liftDialog(model, DestinationDialog.openNew(model.destinationDialog, defaultDestinationForm(type))),
		})
	if (kind === "chat") {
		const [connector = "", workspaceId = ""] = rest
		const workspace = (model.connectors ?? [])
			.flatMap((entry) => entry.workspaces)
			.find((candidate) => candidate.id === workspaceId)
		return workspace === undefined
			? { model }
			: liftDialog(model, DestinationDialog.openNew(model.destinationDialog, chatDestinationForm(connector, workspace.id)))
	}
	return { model }
}

export const menuStep = (model: Model, menuId: string, message: Menu.Message): Return => {
	const result = Menu.update(model.menus[menuId] ?? Menu.init(menuId), message)
	const next: Model = { ...model, menus: { ...model.menus, [menuId]: result.model } }
	const commands = Command.mapMessages(result.commands ?? [], (child) => Message.GotMenuMessage({ id: menuId, message: child }))
	const out = result.outMessage
	if (out === undefined || out._tag !== "SelectedItem") return { model: next, commands }
	const after = picked(next, menuId, out.value)
	return { ...after, commands: [...commands, ...(after.commands ?? [])] }
}

export const removeDestination = (model: Model, tier: Tier, id: AlertDestinationId): Return =>
	model.form === null ? { model } : { model: { ...model, form: updateTierIds(model.form, tier, removeId(id)) } }

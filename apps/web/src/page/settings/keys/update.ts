import type { ApiKeyKind } from "@maple/domain/http"
import { Array, Option, Result } from "effect"
import { Command } from "foldkit"
import { PageOutMessage, type PageReturn } from "../../contract"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import { RevokeApiKey } from "./command"
import * as CreateDialog from "./create-dialog"
import { Message } from "./message"
import { KeyStatusFilter, type Model } from "./model"
import * as RollDialog from "./roll-dialog"

type Return = PageReturn<Model, Message>

export const STATUS_VALUES = KeyStatusFilter.literals

export const init = (options: Readonly<{ isAdmin: boolean; userId: string | null }>): Return => ({
	model: {
		isAdmin: options.isAdmin,
		userId: options.userId,
		apiKeys: null,
		isLoadFailed: false,
		typeFilter: "all",
		statusFilter: "active",
		statusSelect: Select.init("keys-status", { value: "active", selectedIndex: 0 }),
		search: "",
		createMenu: Menu.init("keys-create-menu"),
		rowMenus: {},
		revokeDialog: Dialog.init("keys-revoke", "alert-dialog"),
		revoking: null,
		isRevoking: false,
		roll: RollDialog.init("keys-roll"),
		create: CreateDialog.init("keys-create"),
		baseUrlCopy: CopyButton.init(),
		isScopesOpen: false,
	},
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

// CHILDREN

const liftRevoke = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, revokeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRevokeDialogMessage({ message }),
	),
})

const liftCreate = (model: Model, step: ReturnType<typeof CreateDialog.update>): Return => ({
	model: { ...model, create: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotCreateMessage({ message })),
	outMessage:
		step.outMessage?._tag === "RequestedToast"
			? toast(step.outMessage.type, step.outMessage.title, step.outMessage.description)
			: // A created key needs nothing here: the table follows the synced shape.
				undefined,
})

const liftRoll = (model: Model, step: ReturnType<typeof RollDialog.update>): Return => ({
	model: { ...model, roll: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotRollMessage({ message })),
	outMessage:
		step.outMessage === undefined
			? undefined
			: toast(step.outMessage.type, step.outMessage.title, step.outMessage.description),
})

export const openCreate = (model: Model, kind: ApiKeyKind): Return =>
	liftCreate(model, CreateDialog.open(model.create, kind))

/** A row menu's pick: roll or revoke the key it belongs to. */
const pickedRowAction = (model: Model, menuId: string, value: string): Return => {
	return Option.match(
		Array.findFirst(model.apiKeys ?? [], (key) => `keys-row-${key.id}` === menuId),
		{
			onNone: () => ({ model }),
			onSome: (key) =>
				value === "revoke"
					? liftRevoke({ ...model, revoking: key }, Dialog.open(model.revokeDialog))
					: liftRoll(model, RollDialog.open(model.roll, key)),
		},
	)
}

const updateMenu = (
	model: Model,
	current: Menu.Model,
	message: Menu.Message,
	write: (model: Model, menu: Menu.Model) => Model,
	wrap: (message: Menu.Message) => Message,
	onPick: (model: Model, value: string) => Return,
): Return => {
	const step = Menu.update(current, message)
	const next = write(model, step.model)
	const commands = Command.mapMessages(step.commands ?? [], wrap)
	const picked =
		step.outMessage?._tag === "SelectedItem" ? Option.some(step.outMessage.value) : Option.none()
	return Option.match(picked, {
		onNone: () => ({ model: next, commands }),
		onSome: (value) => {
			const after = onPick(next, value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
	})
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		UpdatedApiKeys: ({ rows }) => ({ model: { ...model, apiKeys: rows, isLoadFailed: false } }),
		FailedLoadApiKeys: () => ({ model: { ...model, isLoadFailed: true } }),
		// `retryOrgCollections`: a stopped shape syncs again only on fresh collections. The failure
		// stays up until the sync answers, so an auto-retry probe does not flash the skeleton.
		ClickedRetryLoad: () => ({
			model,
			outMessage: PageOutMessage.RequestedReconnectOrgCollections(),
		}),
		ClickedTypeFilter: ({ type }) => ({ model: { ...model, typeFilter: type } }),
		GotStatusSelectMessage: ({ message: child }) => {
			const step = Select.update(model.statusSelect, child)
			const lifted = {
				model: { ...model, statusSelect: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotStatusSelectMessage({ message: inner }),
				),
			}
			return Option.match(
				Option.flatMap(Option.fromNullishOr(step.outMessage), (out) =>
					Array.findFirst(STATUS_VALUES, (status) => status === out.value),
				),
				{
					onNone: () => lifted,
					onSome: (status) => ({ ...lifted, model: { ...lifted.model, statusFilter: status } }),
				},
			)
		},
		ChangedSearch: ({ value }) => ({ model: { ...model, search: value } }),
		ClickedClearSearch: () => ({ model: { ...model, search: "" } }),
		ClickedCreateKey: () => openCreate(model, model.isAdmin ? "standard" : "mcp"),
		GotCreateMenuMessage: ({ message: child }) =>
			updateMenu(
				model,
				model.createMenu,
				child,
				(next, menu) => ({ ...next, createMenu: menu }),
				(inner) => Message.GotCreateMenuMessage({ message: inner }),
				(next, value) => openCreate(next, value === "mcp" ? "mcp" : "standard"),
			),
		GotRowMenuMessage: ({ menuId, message: child }) =>
			updateMenu(
				model,
				model.rowMenus[menuId] ?? Menu.init(menuId),
				child,
				(next, menu) => ({ ...next, rowMenus: { ...next.rowMenus, [menuId]: menu } }),
				(inner) => Message.GotRowMenuMessage({ menuId, message: inner }),
				(next, value) => pickedRowAction(next, menuId, value),
			),
		GotRevokeDialogMessage: ({ message: child }) =>
			model.isRevoking ? { model } : liftRevoke(model, Dialog.update(model.revokeDialog, child)),
		ClickedConfirmRevoke: () =>
			model.isRevoking || model.revoking === null
				? { model }
				: {
						model: { ...model, isRevoking: true },
						commands: [RevokeApiKey({ id: model.revoking.id })],
					},
		CompletedRevoke: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					...liftRevoke({ ...model, isRevoking: false }, Dialog.close(model.revokeDialog)),
					outMessage: toast("success", "Key revoked"),
				}),
				onFailure: (error) => ({
					model: { ...model, isRevoking: false },
					outMessage: toast("error", "Couldn't revoke key", error.message),
				}),
			}),
		GotRollMessage: ({ message: child }) => liftRoll(model, RollDialog.update(model.roll, child)),
		GotCreateMessage: ({ message: child }) => liftCreate(model, CreateDialog.update(model.create, child)),
		GotBaseUrlCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.baseUrlCopy, child)
			return {
				model: { ...model, baseUrlCopy: step.model },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotBaseUrlCopyMessage({ message: inner }),
				),
			}
		},
		ToggledScopes: () => ({ model: { ...model, isScopesOpen: !model.isScopesOpen } }),
	})

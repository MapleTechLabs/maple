import { RoleRef } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Option, Result, Schema, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import { failureMessage, settleTo } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import * as CreateDialog from "./create-dialog"
import { Message, type Model } from "./model"
import {
	builtInEntries,
	deleteRole,
	findRole,
	listRoleMembers,
	listRoles,
	type RoleEntry,
	roleEntries,
	roleHref,
} from "./roles"

type Return = PageReturn<Model, Message>

export const FetchRoles = Command.define("FetchRoles", {
	messages: [Message.CompletedFetchRoles],
	execute: listRoles.pipe(settleTo((result) => Message.CompletedFetchRoles({ result }))),
})

const FetchDeleteMembers = Command.define("FetchDeletedRoleMembers", {
	args: { roleId: Policy.CustomRoleId },
	messages: [Message.CompletedFetchDeleteMembers],
	execute: ({ roleId }) =>
		listRoleMembers(roleId).pipe(
			settleTo((result) => Message.CompletedFetchDeleteMembers({ roleId, result })),
		),
})

export const DeleteRole = Command.define("DeleteRole", {
	args: { roleId: Policy.CustomRoleId, name: Schema.String, reassignTo: Schema.NullOr(RoleRef) },
	messages: [Message.CompletedDelete],
	execute: ({ roleId, name, reassignTo }) =>
		deleteRole(roleId, reassignTo).pipe(settleTo((result) => Message.CompletedDelete({ name, result }))),
})

/** The member role, where a deleted role's members move unless another is picked. */
const DEFAULT_REASSIGN = "member"

/** The roles as listed, or the built-in ones alone until the list answers. */
export const entriesOf = (model: Pick<Model, "list">): ReadonlyArray<RoleEntry> =>
	AsyncData.getOrElse(AsyncData.map(model.list, roleEntries), () => builtInEntries)

export const init = (grants: ReadonlyArray<Policy.Permission>): Return => ({
	model: {
		grants,
		list: AsyncData.Loading(),
		rowMenus: {},
		create: CreateDialog.init("role-create"),
		deleting: null,
		deleteDialog: Dialog.init("role-delete", "alert-dialog"),
		deleteMembers: AsyncData.Idle(),
		reassignTo: Select.init("role-reassign", { value: DEFAULT_REASSIGN, selectedIndex: 1 }),
		isDeleting: false,
	},
	commands: [FetchRoles()],
})

/** Back on the tab: the list stays up while it reads again (counts change on the Members page). */
export const revisit = (model: Model): Return => {
	const list = revisitData(model.list, () => FetchRoles())
	return { model: { ...model, list: list.data }, commands: list.commands }
}

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const liftDelete = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const liftCreate = (model: Model, step: ReturnType<typeof CreateDialog.update>): Return => ({
	model: { ...model, create: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotCreateMessage({ message })),
	outMessage:
		step.outMessage === undefined
			? undefined
			: PageOutMessage.RequestedNavigation({
					url: roleHref(step.outMessage.key),
					isReplace: false,
					toast: { type: "success", title: `${step.outMessage.name} created`, description: "" },
				}),
})

const openDelete = (model: Model, role: RoleEntry): Return => {
	if (role.ref._tag !== "Custom") return { model }
	const roleId = role.ref.id
	const opened = liftDelete(
		{
			...model,
			deleting: { id: roleId, name: role.name, memberCount: role.memberCount },
			deleteMembers: role.memberCount > 0 ? AsyncData.Loading() : AsyncData.Idle(),
			reassignTo: Select.init(model.reassignTo.id, { value: DEFAULT_REASSIGN, selectedIndex: 1 }),
		},
		Dialog.open(model.deleteDialog),
	)
	return role.memberCount > 0
		? { ...opened, commands: [...(opened.commands ?? []), FetchDeleteMembers({ roleId })] }
		: opened
}

const pickedRowAction = (model: Model, menuId: string, value: string): Return =>
	Option.match(findRole(entriesOf(model), Str.slice("role-actions-".length)(menuId)), {
		onNone: () => ({ model }),
		onSome: (role) => {
			switch (value) {
				case "duplicate":
					return liftCreate(model, CreateDialog.open(model.create, entriesOf(model), role.key))
				case "delete":
					return openDelete(model, role)
				default:
					return {
						model,
						outMessage: PageOutMessage.RequestedNavigation({
							url: roleHref(role.key),
							isReplace: false,
						}),
					}
			}
		},
	})

/** The role the deleted one's members move to, when anyone holds it. */
const reassignRef = (model: Model): RoleRef | null =>
	model.deleting === null || model.deleting.memberCount === 0
		? null
		: Option.getOrNull(Option.map(findRole(entriesOf(model), model.reassignTo.value), (role) => role.ref))

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchRoles: ({ result }) => ({
			model: { ...model, list: AsyncData.settle(model.list, result) },
		}),
		ClickedRetry: () => ({ model: { ...model, list: AsyncData.Loading() }, commands: [FetchRoles()] }),
		ClickedCreate: () => liftCreate(model, CreateDialog.open(model.create, entriesOf(model), null)),
		GotCreateMessage: ({ message: child }) =>
			liftCreate(model, CreateDialog.update(model.create, child, entriesOf(model))),
		GotRowMenuMessage: ({ menuId, message: child }) => {
			const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotRowMenuMessage({ menuId, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			const after = pickedRowAction(next, menuId, step.outMessage.value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDelete(model, Dialog.update(model.deleteDialog, child)),
		CompletedFetchDeleteMembers: ({ roleId, result }) =>
			model.deleting?.id === roleId
				? { model: { ...model, deleteMembers: AsyncData.settle(model.deleteMembers, result) } }
				: { model },
		GotReassignMessage: ({ message: child }) => {
			const step = Select.update(model.reassignTo, child)
			return {
				model: { ...model, reassignTo: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotReassignMessage({ message: inner }),
				),
			}
		},
		ClickedConfirmDelete: () => {
			const deleting = model.deleting
			if (deleting === null || model.isDeleting) return { model }
			return {
				model: { ...model, isDeleting: true },
				commands: [
					DeleteRole({ roleId: deleting.id, name: deleting.name, reassignTo: reassignRef(model) }),
				],
			}
		},
		CompletedDelete: ({ name, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftDelete(
						{ ...model, isDeleting: false, deleting: null },
						Dialog.close(model.deleteDialog),
					)
					const list = revisit(closed.model)
					return {
						model: list.model,
						commands: [...(closed.commands ?? []), ...(list.commands ?? [])],
						outMessage: toast("success", `${name} deleted`),
					}
				},
				// The dialog stays open with its role so the admin can try again.
				onFailure: (failure) => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", `Couldn't delete ${name}`, failureMessage(failure)),
				}),
			}),
	})

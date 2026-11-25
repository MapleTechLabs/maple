import * as Policy from "@maple/domain/policy"
import { Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { dashboardPage } from "../page/kit/dashboard-page"
import * as CreateDialog from "../page/settings/roles/create-dialog"
import * as RolesModel from "../page/settings/roles/model"
import {
	CHECKOUT_TEAM,
	ON_CALL,
	roleList,
	roleMembers,
	STATUS_EDITOR,
} from "../page/settings/roles/test-roles"
import * as RolesUpdate from "../page/settings/roles/update"
import * as RolesView from "../page/settings/roles/view"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/roles`: the settings Roles tab over fixtures. `?state=` picks a start: the list as an admin
// (`list`), as a member who cannot change roles (`member`), loading, a failed load, the create
// dialog, or the delete dialog on a role three people hold.

export const LabState = Schema.Literals(["list", "member", "loading", "error", "create", "delete"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "list",
	),
}))

export const Model = Schema.Struct({ roles: RolesModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotRolesMessage: { message: RolesModel.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const LIST = roleList([CHECKOUT_TEAM, ON_CALL, STATUS_EDITOR])

const opened = (dialog: Dialog.Model): Dialog.Model => Dialog.init(dialog.id, dialog.kind, { isOpen: true })

const step = (model: RolesModel.Model, message: RolesModel.Message): RolesModel.Model =>
	RolesUpdate.update(model, message).model

const stateOf = (flags: Flags): RolesModel.Model => {
	const grants = Policy.grantsOf([flags.state === "member" ? "org:member" : "org:admin"])
	const fresh = RolesUpdate.init(grants).model
	if (flags.state === "loading") return fresh
	if (flags.state === "error")
		return step(
			fresh,
			RolesModel.Message.CompletedFetchRoles({
				result: Result.fail(toLoadFailure(new Error("Roles are temporarily unavailable"))),
			}),
		)
	const loaded = step(fresh, RolesModel.Message.CompletedFetchRoles({ result: Result.succeed(LIST) }))
	if (flags.state === "create") {
		const create = CreateDialog.open(loaded.create, RolesUpdate.entriesOf(loaded), null).model
		return { ...loaded, create: { ...create, name: "Incident commander", dialog: opened(create.dialog) } }
	}
	if (flags.state === "delete") {
		const deleting = step(
			loaded,
			RolesModel.Message.GotRowMenuMessage({
				menuId: `role-actions-${ON_CALL.id}`,
				message: { _tag: "ClickedItem", index: 2, item: { kind: "Item", value: "delete" } },
			}),
		)
		const withMembers = step(
			deleting,
			RolesModel.Message.CompletedFetchDeleteMembers({
				roleId: ON_CALL.id,
				result: Result.succeed(
					roleMembers([
						{ id: "user_grace", name: "Grace Hopper" },
						{ id: "user_alan", name: "Alan Turing" },
						{ id: "user_katherine", name: "Katherine Johnson" },
					]),
				),
			}),
		)
		return { ...withMembers, deleteDialog: opened(withMembers.deleteDialog) }
	}
	return loaded
}

export const init = (flags: Flags): Return => ({ model: { roles: stateOf(flags) } })

/** Kit commands run; every roles read and write is dropped, so a save stays pending. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotRolesMessage: ({ message: child }) => {
			const next = RolesUpdate.update(model.roles, child)
			return {
				model: { roles: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (message) =>
					Message.GotRolesMessage({ message }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Roles" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	dashboardPage(
		h,
		{
			title: "Roles",
			description: RolesView.description(h),
			width: "settings",
			actions: h.submodel({
				slotId: "lab-roles-actions",
				model: model.roles,
				view: RolesView.headerActions,
				viewInputs: {},
				toParentMessage: (message: RolesModel.Message) => Message.GotRolesMessage({ message }),
			}),
		},
		[
			h.submodel({
				slotId: "lab-roles",
				model: model.roles,
				view: RolesView.view,
				viewInputs: {},
				toParentMessage: (message: RolesModel.Message) => Message.GotRolesMessage({ message }),
			}),
		],
	)

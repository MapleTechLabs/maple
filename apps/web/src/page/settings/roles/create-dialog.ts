import { CustomRoleResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { failureMessage, LoadFailure, settleTo } from "@maple/views/data/load-failure"
import { alert, alertDescription } from "@maple/views/ui/alert"
import * as Dialog from "@maple/views/ui/dialog"
import { fieldGroupLabel } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import * as Select from "@maple/views/ui/select"
import * as SelectView from "@maple/views/ui/select-view"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { Resources } from "../../../platform/resources"
import {
	createRole,
	findRole,
	grantablePermissions,
	isValidRoleDescription,
	isValidRoleName,
	RoleDraft,
	type RoleEntry,
} from "./roles"
import { roleTextField } from "./view-parts"

// The create-role dialog, one Submodel shared by the Roles tab and the role editor (Duplicate):
// a name, a description, and the role it starts from (none, or any built-in or custom role).
// Created, the opener goes to its editor.

/** The template value for no role: built-in keys are names and custom keys ids, so none is "". */
const NO_TEMPLATE = ""

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	name: Schema.String,
	description: Schema.String,
	/** The role whose permissions the new one starts with: a role's key, or `NO_TEMPLATE`. */
	template: Select.Model,
	isCreating: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	GotTemplateMessage: { message: Select.Message },
	SubmittedCreate: {},
	CompletedCreate: { result: Schema.Result(CustomRoleResponse, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ CreatedRole: { key: Schema.String, name: Schema.String } })
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	name: "",
	description: "",
	template: Select.init(`${id}-template`, { value: NO_TEMPLATE, selectedIndex: 0 }),
	isCreating: false,
	error: null,
})

export const CreateRole = Command.define("CreateRole", {
	args: RoleDraft.fields,
	messages: [Message.CompletedCreate],
	execute: (input) => createRole(input).pipe(settleTo((result) => Message.CompletedCreate({ result }))),
})

const COPY_SUFFIX = " copy"

/** "<name> copy", the name cut so the whole fits a role name. */
const copyName = (name: string): string =>
	`${Str.trimEnd(Str.slice(0, Policy.CUSTOM_ROLE_NAME_MAX - COPY_SUFFIX.length)(name))}${COPY_SUFFIX}`

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/** The template list: no role first, then every role in list order. */
const templateKeys = (entries: ReadonlyArray<RoleEntry>): ReadonlyArray<string> => [
	NO_TEMPLATE,
	...Arr.map(entries, (entry) => entry.key),
]

/** Opens the dialog empty, or as a copy of the role `from` names. */
export const open = (model: Model, entries: ReadonlyArray<RoleEntry>, from: string | null): Return => {
	const source = from === null ? Option.none() : findRole(entries, from)
	const template = Option.match(source, { onNone: () => NO_TEMPLATE, onSome: (role) => role.key })
	const fresh: Model = {
		...model,
		name: Option.match(source, { onNone: () => "", onSome: (role) => copyName(role.name) }),
		description: Option.match(source, {
			onNone: () => "",
			onSome: (role) => Str.slice(0, Policy.CUSTOM_ROLE_DESCRIPTION_MAX)(role.description),
		}),
		template: Select.init(model.template.id, {
			value: template,
			selectedIndex: Option.getOrNull(
				Arr.findFirstIndex(templateKeys(entries), (key) => key === template),
			),
		}),
		isCreating: false,
		error: null,
	}
	return liftDialog(fresh, Dialog.open(model.dialog))
}

/** The permissions the new role starts with: those the template holds that a custom role may. */
export const startingPermissions = (
	model: Model,
	entries: ReadonlyArray<RoleEntry>,
): ReadonlyArray<Policy.Permission> =>
	Option.match(findRole(entries, model.template.value), {
		onNone: () => [],
		onSome: (role) => grantablePermissions(role.permissions),
	})

/** The namespaces the new role starts limited to: the template's, so a copy of a limited role stays limited. */
export const startingNamespaces = (model: Model, entries: ReadonlyArray<RoleEntry>): ReadonlyArray<string> =>
	Option.match(findRole(entries, model.template.value), {
		onNone: () => [],
		onSome: (role) => role.namespaces,
	})

const canSubmit = (model: Model): boolean =>
	isValidRoleName(model.name) && isValidRoleDescription(model.description)

export const update = (model: Model, message: Message, entries: ReadonlyArray<RoleEntry>): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) =>
			model.isCreating ? { model } : liftDialog(model, Dialog.update(model.dialog, child)),
		ChangedName: ({ value }) => ({ model: { ...model, name: value, error: null } }),
		ChangedDescription: ({ value }) => ({ model: { ...model, description: value } }),
		GotTemplateMessage: ({ message: child }) => {
			const step = Select.update(model.template, child)
			return {
				model: { ...model, template: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotTemplateMessage({ message: inner }),
				),
			}
		},
		SubmittedCreate: () =>
			model.isCreating || !canSubmit(model)
				? { model }
				: {
						model: { ...model, isCreating: true, error: null },
						commands: [
							CreateRole({
								name: Str.trim(model.name),
								description: Str.trim(model.description),
								permissions: startingPermissions(model, entries),
								namespaces: startingNamespaces(model, entries),
							}),
						],
					},
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				onSuccess: (role) => ({
					...liftDialog({ ...model, isCreating: false }, Dialog.close(model.dialog)),
					outMessage: OutMessage.CreatedRole({ key: role.id, name: role.name }),
				}),
				// A taken name or the role limit: said in the dialog, which stays open to fix it.
				onFailure: (failure) => ({
					model: { ...model, isCreating: false, error: failureMessage(failure) },
				}),
			}),
	})

type H = HtmlBuilder<Message>

const permissionCount = (role: RoleEntry): string => {
	const count = grantablePermissions(role.permissions).length
	return `${count} ${count === 1 ? "permission" : "permissions"}`
}

const NO_TEMPLATE_LABEL = "No role"

/** What the picked template gives the new role, under the picker. */
const templateDetail = (model: Model, entries: ReadonlyArray<RoleEntry>): string =>
	Option.match(findRole(entries, model.template.value), {
		onNone: () => "Starts with no permissions.",
		onSome: (role) =>
			role.description === ""
				? `${permissionCount(role)}.`
				: `${permissionCount(role)}. ${role.description}`,
	})

const roleOptions = (entries: ReadonlyArray<RoleEntry>) =>
	Arr.map(entries, (role) => ({ value: role.key, label: role.name }))

const templateSelect = (h: H, model: Model, entries: ReadonlyArray<RoleEntry>): Html => {
	const builtIn = Arr.filter(entries, (entry) => entry.isBuiltIn)
	const custom = Arr.filter(entries, (entry) => !entry.isBuiltIn)
	return h.submodel({
		slotId: model.template.id,
		model: model.template,
		view: SelectView.view,
		toParentMessage: (message) => Message.GotTemplateMessage({ message }),
		viewInputs: {
			entries: [
				{ _tag: "Item", item: { value: NO_TEMPLATE, label: NO_TEMPLATE_LABEL } },
				{ _tag: "Separator" },
				{ _tag: "Group", label: "Built-in roles", items: roleOptions(builtIn) },
				...(custom.length === 0
					? []
					: [{ _tag: "Group" as const, label: "Custom roles", items: roleOptions(custom) }]),
			],
			labelledBy: `${model.template.id}-label`,
			describedBy: `${model.template.id}-detail`,
			className: "w-full",
			renderValue: (value) => [
				Option.match(findRole(entries, value), {
					onNone: () => NO_TEMPLATE_LABEL,
					onSome: (role) => role.name,
				}),
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

/** The dialog; `entries` are the roles it can start from. */
export const view = Submodel.defineView<Model, Message, Readonly<{ entries: ReadonlyArray<RoleEntry> }>>(
	(model, { entries }, h) => dialogView(h, model, entries),
)

const dialogView = (h: H, model: Model, entries: ReadonlyArray<RoleEntry>): Html => {
	return formDialog(h, {
		slotId: model.dialog.id,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		title: "Create role",
		description: "Choose its permissions next. Nobody holds it until you assign it on the Members page.",
		onSubmit: Message.SubmittedCreate(),
		submitLabel: "Create and choose permissions",
		isPending: model.isCreating,
		isSubmitDisabled: !canSubmit(model),
		fields: [
			roleTextField(h, {
				id: `${model.dialog.id}-name`,
				label: "Name",
				value: model.name,
				placeholder: "On-call responder",
				maxLength: Policy.CUSTOM_ROLE_NAME_MAX,
				isInvalid: model.error !== null,
				onInput: (value) => Message.ChangedName({ value }),
			}),
			roleTextField(h, {
				id: `${model.dialog.id}-description`,
				label: "Description (optional)",
				value: model.description,
				description: "Shown in the role picker.",
				maxLength: Policy.CUSTOM_ROLE_DESCRIPTION_MAX,
				onInput: (value) => Message.ChangedDescription({ value }),
			}),
			vstack(h, { gap: "2" }, [
				fieldGroupLabel(h, { attributes: [h.Id(`${model.template.id}-label`)] }, "Start from"),
				templateSelect(h, model, entries),
				// Two lines held whatever the pick, so the dialog never resizes under the picker.
				h.div(
					[h.Id(`${model.template.id}-detail`), h.Class("min-h-8")],
					[
						typography(h, { size: "xs", tone: "muted", className: "line-clamp-2" }, [
							templateDetail(model, entries),
						]),
					],
				),
			]),
			...(model.error === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertDescription(h, [model.error]),
						]),
					]),
		],
	})
}

import { CustomRoleResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { failureMessage, LoadFailure, settleTo } from "@maple/views/data/load-failure"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { radioCard } from "@maple/views/ui/control-card"
import * as Dialog from "@maple/views/ui/dialog"
import { fieldGroupLabel } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import * as RadioGroup from "@maple/views/ui/radio-group"
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
// a name, a description, and the role it starts from. Created, the opener goes to its editor.

/** `custom` copies the role picked in `copyFrom`; a built-in role's key copies that role. */
const EMPTY = "empty"
const CUSTOM = "custom"

/** The built-in roles offered as a start whatever was duplicated. */
const OFFERED_BUILT_INS = ["member", "engineer"]

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	name: Schema.String,
	description: Schema.String,
	start: RadioGroup.Model,
	copyFrom: Select.Model,
	/** A duplicated built-in role not offered by default (Analyst, Admin), listed for this opening. */
	duplicatedBuiltIn: Schema.NullOr(Schema.String),
	isCreating: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	GotStartMessage: { message: RadioGroup.Message },
	GotCopyFromMessage: { message: Select.Message },
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
	start: RadioGroup.init(EMPTY),
	copyFrom: Select.init(`${id}-copy-from`, { value: "", selectedIndex: null }),
	duplicatedBuiltIn: null,
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

const customRoles = (entries: ReadonlyArray<RoleEntry>) => Arr.filter(entries, (entry) => !entry.isBuiltIn)

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/** Opens the dialog empty, or as a copy of the role `from` names. */
export const open = (model: Model, entries: ReadonlyArray<RoleEntry>, from: string | null): Return => {
	const source = from === null ? Option.none() : findRole(entries, from)
	const firstCustom = Option.getOrNull(Arr.head(customRoles(entries)))
	const copyFrom = Option.match(source, {
		onNone: () => firstCustom?.key ?? "",
		onSome: (role) => (role.isBuiltIn ? (firstCustom?.key ?? "") : role.key),
	})
	const start = Option.match(source, {
		onNone: () => EMPTY,
		onSome: (role) => (role.isBuiltIn ? role.key : CUSTOM),
	})
	const fresh: Model = {
		...model,
		name: Option.match(source, { onNone: () => "", onSome: (role) => copyName(role.name) }),
		description: Option.match(source, {
			onNone: () => "",
			onSome: (role) => Str.slice(0, Policy.CUSTOM_ROLE_DESCRIPTION_MAX)(role.description),
		}),
		start: RadioGroup.init(start),
		copyFrom: Select.init(model.copyFrom.id, {
			value: copyFrom,
			selectedIndex: Option.getOrNull(
				Arr.findFirstIndex(customRoles(entries), (entry) => entry.key === copyFrom),
			),
		}),
		duplicatedBuiltIn: Option.match(source, {
			onNone: () => null,
			onSome: (role) => (role.isBuiltIn && !OFFERED_BUILT_INS.includes(role.key) ? role.key : null),
		}),
		isCreating: false,
		error: null,
	}
	return liftDialog(fresh, Dialog.open(model.dialog))
}

const startValue = (model: Model): string => Option.getOrElse(model.start.maybeValue, () => EMPTY)

/** The permissions the new role starts with: those the chosen role holds that a custom role may. */
export const startingPermissions = (
	model: Model,
	entries: ReadonlyArray<RoleEntry>,
): ReadonlyArray<Policy.Permission> => {
	const start = startValue(model)
	if (start === EMPTY) return []
	const key = start === CUSTOM ? model.copyFrom.value : start
	return Option.match(findRole(entries, key), {
		onNone: () => [],
		onSome: (role) => grantablePermissions(role.permissions),
	})
}

const canSubmit = (model: Model): boolean =>
	isValidRoleName(model.name) &&
	isValidRoleDescription(model.description) &&
	(startValue(model) !== CUSTOM || model.copyFrom.value !== "")

export const update = (model: Model, message: Message, entries: ReadonlyArray<RoleEntry>): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) =>
			model.isCreating ? { model } : liftDialog(model, Dialog.update(model.dialog, child)),
		ChangedName: ({ value }) => ({ model: { ...model, name: value, error: null } }),
		ChangedDescription: ({ value }) => ({ model: { ...model, description: value } }),
		GotStartMessage: ({ message: child }) => {
			const step = RadioGroup.update(model.start, child)
			return {
				model: { ...model, start: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotStartMessage({ message: inner }),
				),
			}
		},
		GotCopyFromMessage: ({ message: child }) => {
			const step = Select.update(model.copyFrom, child)
			return {
				// Picking a role to copy picks "Copy a custom role" too.
				model: {
					...model,
					copyFrom: step.model,
					start: step.outMessage === undefined ? model.start : RadioGroup.init(CUSTOM),
				},
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotCopyFromMessage({ message: inner }),
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

type StartOption = Readonly<{ value: string; title: string; detail: string }>

const permissionsLine = (role: RoleEntry): string => {
	const count = grantablePermissions(role.permissions).length
	return `${count} ${count === 1 ? "permission" : "permissions"}. ${role.description}`
}

const startOptions = (model: Model, entries: ReadonlyArray<RoleEntry>): ReadonlyArray<StartOption> => [
	{ value: EMPTY, title: "Empty", detail: "No permissions." },
	...Arr.flatMap(entries, (role) =>
		role.isBuiltIn && (OFFERED_BUILT_INS.includes(role.key) || role.key === model.duplicatedBuiltIn)
			? [{ value: role.key, title: `Copy ${role.name}`, detail: permissionsLine(role) }]
			: [],
	),
	...(customRoles(entries).length === 0
		? []
		: [
				{
					value: CUSTOM,
					title: "Copy a custom role",
					detail: "Start from one of this organization's roles.",
				},
			]),
]

const radioId = (model: Model, value: string) => `${model.dialog.id}-start-${value}`

const startCard = (h: H, config: RadioGroup.RadioGroupViewConfig<Message>, option: StartOption) =>
	radioCard(h, { config, value: option.value }, [
		vstack(h, { gap: "0.5", shrink: true, as: "span" }, [
			typography(h, { size: "sm", weight: "medium" }, [option.title]),
			typography(h, { size: "xs", tone: "muted" }, [option.detail]),
		]),
	])

const copyFromSelect = (h: H, model: Model, entries: ReadonlyArray<RoleEntry>): Html =>
	h.submodel({
		slotId: model.copyFrom.id,
		model: model.copyFrom,
		view: SelectView.view,
		toParentMessage: (message) => Message.GotCopyFromMessage({ message }),
		viewInputs: {
			entries: Arr.map(customRoles(entries), (role) => ({
				_tag: "Item" as const,
				item: { value: role.key, label: role.name },
			})),
			ariaLabel: "Custom role to copy",
			size: "sm",
			className: "ml-7 w-auto min-w-48",
			renderValue: (value) => [
				Option.match(findRole(entries, value), {
					onNone: () => "Choose a role",
					onSome: (role) => role.name,
				}),
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})

/** The dialog; `entries` are the roles it can start from. */
export const view = Submodel.defineView<Model, Message, Readonly<{ entries: ReadonlyArray<RoleEntry> }>>(
	(model, { entries }, h) => dialogView(h, model, entries),
)

const dialogView = (h: H, model: Model, entries: ReadonlyArray<RoleEntry>): Html => {
	const options = startOptions(model, entries)
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: model.start,
		toParentMessage: (message) => Message.GotStartMessage({ message }),
		items: Arr.map(options, (option) => ({
			value: option.value,
			id: radioId(model, option.value),
			inputId: `${radioId(model, option.value)}-input`,
		})),
	}
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
				fieldGroupLabel(h, {}, "Start from"),
				RadioGroup.radioGroup(
					h,
					{ label: "Start from", className: "gap-2" },
					Arr.flatMap(options, (option) => startCard(h, config, option)),
				),
				...(startValue(model) === CUSTOM ? [copyFromSelect(h, model, entries)] : []),
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

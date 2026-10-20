import { IngestMappingOperation, IngestMappingSourceContext } from "@maple/domain/http"
import { V2AttributeMapping } from "@maple/domain/http/v2"
import { getResourceAttributeKeys, getSpanAttributeKeys } from "@maple/web-data/warehouse/traces"
import { Effect, Result, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"

// The add / edit dialog of `AttributeMappingsSection`, with `AttributeKeyAutocomplete`'s two key lists (read
// once, when the dialog first opens).

export const KeysData = AsyncData.Schema(Schema.Array(Schema.String), LoadFailure)

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	editing: Schema.NullOr(V2AttributeMapping),
	name: Field.Model,
	sourceContext: Select.Model,
	sourceKey: Combobox.Model,
	targetKey: Combobox.Model,
	operation: Select.Model,
	isSaving: Schema.Boolean,
	/** An Escape that closed a key's suggestions: the same keydown reaching the dialog is dropped. */
	isEscapeConsumed: Schema.Boolean,
	spanKeys: KeysData.schema,
	resourceKeys: KeysData.schema,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	editing: null,
	name: Field.init(),
	sourceContext: Select.init(`${id}-context`, { value: "span", selectedIndex: 0 }),
	sourceKey: Combobox.init(`${id}-source-key`, "autocomplete"),
	targetKey: Combobox.init(`${id}-target-key`, "autocomplete"),
	operation: Select.init(`${id}-operation`, { value: "copy", selectedIndex: 0 }),
	isSaving: false,
	isEscapeConsumed: false,
	spanKeys: AsyncData.Idle(),
	resourceKeys: AsyncData.Idle(),
})

export const KeyField = Schema.Literals(["sourceKey", "targetKey"])
export type KeyField = typeof KeyField.Type
export const SelectField = Schema.Literals(["sourceContext", "operation"])
export type SelectField = typeof SelectField.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotNameMessage: { message: Field.Message },
	GotSelectMessage: { field: SelectField, message: Select.Message },
	GotKeyMessage: { field: KeyField, message: Combobox.Message },
	CompletedFetchKeys: { scope: IngestMappingSourceContext, result: Schema.Result(Schema.Array(Schema.String), LoadFailure) },
	ClickedSave: {},
	CompletedSave: { isCreate: Schema.Boolean, result: Schema.Result(Schema.Void, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SavedMapping: { isCreate: Schema.Boolean },
	FailedSave: { isCreate: Schema.Boolean, description: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const FetchAttributeKeys = Command.define("FetchMappingAttributeKeys", {
	args: { scope: IngestMappingSourceContext },
	messages: [Message.CompletedFetchKeys],
	execute: ({ scope }) =>
		(scope === "span" ? getSpanAttributeKeys({ data: {} }) : getResourceAttributeKeys({ data: {} })).pipe(
			Effect.map((response) => response.data.map((row) => row.attributeKey)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchKeys({ scope, result })),
		),
})

const MappingPayload = Schema.Struct({
	name: Schema.String,
	source_context: IngestMappingSourceContext,
	source_key: Schema.String,
	target_key: Schema.String,
	operation: IngestMappingOperation,
})

const SaveMapping = Command.define("SaveAttributeMapping", {
	args: { editingId: Schema.NullOr(V2AttributeMapping.fields.id), payload: MappingPayload },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			if (editingId === null) yield* client.attributeMappings.create({ payload })
			else yield* client.attributeMappings.update({ params: { id: editingId }, payload })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ isCreate: editingId === null, result })),
		),
})

// DERIVED

export const sourceContextOf = (model: Model): IngestMappingSourceContext =>
	model.sourceContext.value === "resource" ? "resource" : "span"
export const operationOf = (model: Model): IngestMappingOperation => (model.operation.value === "move" ? "move" : "copy")

export const isFormValid = (model: Model): boolean =>
	model.name.value.trim().length > 0 &&
	model.sourceKey.inputValue.trim().length > 0 &&
	model.targetKey.inputValue.trim().length > 0

// UPDATE

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

const withKey = (current: Combobox.Model, value: string): Combobox.Model => ({ ...current, inputValue: value })

/** `openAddDialog` / `openEditDialog`: the form filled from the mapping, or empty. */
export const open = (model: Model, editing: V2AttributeMapping | null): Return => {
	const fresh = init(model.dialog.id)
	const filled: Model = {
		...fresh,
		dialog: model.dialog,
		editing,
		spanKeys: model.spanKeys,
		resourceKeys: model.resourceKeys,
		name: Field.init(editing?.name ?? ""),
		sourceContext: { ...fresh.sourceContext, value: editing?.source_context ?? "span" },
		sourceKey: withKey(fresh.sourceKey, editing?.source_key ?? ""),
		targetKey: withKey(fresh.targetKey, editing?.target_key ?? ""),
		operation: { ...fresh.operation, value: editing?.operation ?? "copy" },
	}
	// Both key lists are subscribed on mount, as `AttributeKeyAutocomplete` does.
	const isFirstOpen = AsyncData.isIdle(model.spanKeys)
	const opened = liftDialog(
		isFirstOpen ? { ...filled, spanKeys: AsyncData.Loading(), resourceKeys: AsyncData.Loading() } : filled,
		Dialog.open(model.dialog),
	)
	return {
		...opened,
		commands: [
			...(opened.commands ?? []),
			...(isFirstOpen ? [FetchAttributeKeys({ scope: "span" }), FetchAttributeKeys({ scope: "resource" })] : []),
		],
	}
}

const save = (model: Model): Return => {
	if (model.isSaving || !isFormValid(model)) return { model }
	const payload = {
		name: model.name.value.trim(),
		source_context: sourceContextOf(model),
		source_key: model.sourceKey.inputValue.trim(),
		target_key: model.targetKey.inputValue.trim(),
		operation: operationOf(model),
	}
	return { model: { ...model, isSaving: true }, commands: [SaveMapping({ editingId: model.editing?.id ?? null, payload })] }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => {
			if (child._tag === "PressedEscape" && model.isEscapeConsumed)
				return { model: { ...model, isEscapeConsumed: false } }
			return model.isSaving ? { model } : liftDialog(model, Dialog.update(model.dialog, child))
		},
		GotNameMessage: ({ message: child }) => ({ model: { ...model, name: Field.update(model.name, child).model } }),
		GotSelectMessage: ({ field, message: child }) => {
			const step = Select.update(model[field], child)
			const value = step.outMessage?.value
			return {
				model: { ...model, [field]: value === undefined ? step.model : { ...step.model, value } },
				commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotSelectMessage({ field, message: inner })),
			}
		},
		GotKeyMessage: ({ field, message: child }) => {
			const step = Combobox.update(model[field], child)
			// Base UI's floating tree: Escape in an open popup closes only the popup, not the dialog.
			const isEscapeConsumed = child._tag === "PressedInputKey" && child.key === "Escape" && model[field].isOpen
			return {
				model: { ...model, [field]: step.model, isEscapeConsumed },
				commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotKeyMessage({ field, message: inner })),
			}
		},
		CompletedFetchKeys: ({ scope, result }) =>
			scope === "span"
				? { model: { ...model, spanKeys: AsyncData.settle(model.spanKeys, result) } }
				: { model: { ...model, resourceKeys: AsyncData.settle(model.resourceKeys, result) } },
		ClickedSave: () => save(model),
		CompletedSave: ({ isCreate, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					...liftDialog({ ...model, isSaving: false }, Dialog.close(model.dialog)),
					outMessage: OutMessage.SavedMapping({ isCreate }),
				}),
				onFailure: (error) => ({
					model: { ...model, isSaving: false },
					outMessage: OutMessage.FailedSave({ isCreate, description: error.message }),
				}),
			}),
	})

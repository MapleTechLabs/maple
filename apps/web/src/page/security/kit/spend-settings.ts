import {
	SECURITY_AUDIT_MAX_MONTHLY_SPEND_USD,
	SecurityAuditSettings,
	SecurityAuditUpdateSettingsRequest,
} from "@maple/domain/http"
import { SecurityAuditDiscoveryModel, SecurityAuditValidationModel } from "@maple/domain/security-audit"
import { Effect, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"
import { updateSettings } from "./api"
import { modelIdsFor, type ModelStage } from "./model-picker"

// The Spend & models dialog: the org's monthly spend limit and the models audits run on.

export const DIALOG_ID = "security-spend-settings"

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	limit: Field.Model,
	discovery: Select.Model,
	validation: Select.Model,
	/** The settings the form opened on: this month's spend and when it resets. */
	current: Schema.NullOr(SecurityAuditSettings),
	isSubmitted: Schema.Boolean,
	isPending: Schema.Boolean,
	/** Bumped each time the form opens: an answer for an earlier attempt is dropped. */
	attempt: Schema.Finite,
	failure: Schema.NullOr(LoadFailure),
})
export type Model = typeof Model.Type

const selectFor = (stage: ModelStage, value: string): Select.Model => {
	const index = modelIdsFor(stage).indexOf(value)
	return Select.init(`${DIALOG_ID}-${stage}`, { value, selectedIndex: index === -1 ? null : index })
}

export const init = (): Model => ({
	dialog: Dialog.init(DIALOG_ID, "dialog"),
	limit: Field.init(),
	discovery: selectFor("discovery", ""),
	validation: selectFor("validation", ""),
	current: null,
	isSubmitted: false,
	isPending: false,
	attempt: 0,
	failure: null,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotLimitMessage: { message: Field.Message },
	GotDiscoveryMessage: { message: Select.Message },
	GotValidationMessage: { message: Select.Message },
	Submitted: {},
	CompletedSave: { attempt: Schema.Finite, result: Schema.Result(SecurityAuditSettings, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	Saved: { settings: SecurityAuditSettings },
})
export type OutMessage = typeof OutMessage.Type

export const SaveSecuritySettings = Command.define("SecurityApiUpdateSettings", {
	args: { attempt: Schema.Finite, payload: SecurityAuditUpdateSettingsRequest },
	messages: [Message.CompletedSave],
	execute: ({ attempt, payload }) =>
		Effect.map(updateSettings(payload), (result) => Message.CompletedSave({ attempt, result })),
})

// VALIDATION

const isDiscoveryModel = Schema.is(SecurityAuditDiscoveryModel)
const isValidationModel = Schema.is(SecurityAuditValidationModel)

/** Whole dollars, with or without a thousands separator: `1,000` is 1000, `12,50` is refused. */
const parseLimit = (value: string): number | null => {
	const trimmed = value.trim()
	const parsed = Number(/^\d{1,3}(,\d{3})+$/u.test(trimmed) ? trimmed.replaceAll(",", "") : trimmed)
	return trimmed !== "" &&
		Number.isInteger(parsed) &&
		parsed >= 1 &&
		parsed <= SECURITY_AUDIT_MAX_MONTHLY_SPEND_USD
		? parsed
		: null
}

export type Errors = Readonly<{ limit: string | undefined; validation: string | undefined }>

export const NO_ERRORS: Errors = { limit: undefined, validation: undefined }

export const errorsOf = (model: Model): Errors => ({
	limit:
		parseLimit(model.limit.value) === null
			? `Enter whole dollars from 1 to ${SECURITY_AUDIT_MAX_MONTHLY_SPEND_USD.toLocaleString("en-US")}.`
			: undefined,
	validation:
		model.validation.value === model.discovery.value
			? "Pick a different model than the one hunting, so it does not share the hunter's blind spots."
			: undefined,
})

export const requestOf = (model: Model): SecurityAuditUpdateSettingsRequest | null => {
	const monthlySpendLimitUsd = parseLimit(model.limit.value)
	const discoveryModel = model.discovery.value
	const validationModel = model.validation.value
	if (
		monthlySpendLimitUsd === null ||
		discoveryModel === validationModel ||
		!isDiscoveryModel(discoveryModel) ||
		!isValidationModel(validationModel)
	)
		return null
	return { monthlySpendLimitUsd, discoveryModel, validationModel }
}

/** The limit the form would save, for the usage bar while it is typed; the saved one otherwise. */
export const draftLimitOf = (model: Model): number | null =>
	parseLimit(model.limit.value) ?? model.current?.monthlySpendLimitUsd ?? null

// UPDATE

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const DISMISSALS: ReadonlySet<string> = new Set(["ClickedClose", "PressedEscape", "PressedOutside"])

const dialogCommands = (commands: ReadonlyArray<Command.Command<Dialog.Message>> | undefined) =>
	Command.mapMessages(commands ?? [], (message) => Message.GotDialogMessage({ message }))

/** Opening fills the form from the org's settings, so it never shows a previous attempt. */
export const open = (model: Model, settings: SecurityAuditSettings): Return => {
	const step = Dialog.open(model.dialog)
	return {
		model: {
			...init(),
			dialog: step.model,
			limit: Field.init(String(settings.monthlySpendLimitUsd)),
			discovery: selectFor("discovery", settings.discoveryModel),
			validation: selectFor("validation", settings.validationModel),
			current: settings,
			attempt: model.attempt + 1,
		},
		commands: dialogCommands(step.commands),
	}
}

const close = (model: Model): Return => {
	const step = Dialog.close(model.dialog)
	return {
		model: { ...model, dialog: step.model, isPending: false },
		commands: dialogCommands(step.commands),
	}
}

const selectStep = (
	model: Model,
	select: Select.Model,
	message: Select.Message,
	write: (select: Select.Model) => Partial<Model>,
	wrap: (message: Select.Message) => Message,
): Return => {
	const step = Select.update(select, message)
	const picked = step.outMessage
	const next = picked === undefined ? step.model : { ...step.model, value: picked.value }
	return {
		model: { ...model, ...write(next), failure: null },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => {
			// A save in flight keeps the dialog: the answer has a form to land in.
			if (model.isPending && DISMISSALS.has(inner._tag)) return { model }
			const step = Dialog.update(model.dialog, inner)
			return { model: { ...model, dialog: step.model }, commands: dialogCommands(step.commands) }
		},
		GotLimitMessage: ({ message: inner }) => ({
			model: { ...model, limit: Field.update(model.limit, inner).model },
		}),
		GotDiscoveryMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.discovery,
				inner,
				(discovery) => ({ discovery }),
				(next) => Message.GotDiscoveryMessage({ message: next }),
			),
		GotValidationMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.validation,
				inner,
				(validation) => ({ validation }),
				(next) => Message.GotValidationMessage({ message: next }),
			),
		Submitted: () => {
			if (model.isPending) return { model }
			const request = requestOf(model)
			if (request === null) return { model: { ...model, isSubmitted: true } }
			return {
				model: { ...model, isSubmitted: true, isPending: true, failure: null },
				commands: [SaveSecuritySettings({ attempt: model.attempt, payload: request })],
			}
		},
		CompletedSave: ({ attempt, result }) =>
			attempt !== model.attempt || !model.isPending
				? { model }
				: Result.match(result, {
						onFailure: (failure) => ({ model: { ...model, isPending: false, failure } }),
						onSuccess: (settings) => ({
							...close({ ...model, current: settings }),
							outMessage: OutMessage.Saved({ settings }),
						}),
					}),
	})

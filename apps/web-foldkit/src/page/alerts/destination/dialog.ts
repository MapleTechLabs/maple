import {
	type AlertDestinationDocument,
	AlertDestinationId,
	AlertDestinationType,
} from "@maple/domain/http"
import { V2AlertDestinationCreateParams, V2AlertDestinationUpdateParams, V2ChatConnector, V2TelegramChat } from "@maple/domain/http/v2"
import {
	buildDestinationCreateParamsV2,
	buildDestinationUpdateParamsV2,
	chatDestinationForm,
	defaultDestinationForm,
	destinationToFormState,
	MAX_EMAIL_MEMBER_RECIPIENTS,
	suggestedDestinationName,
} from "@maple/web-data/alerts/form-utils"
import { displayError } from "@maple/web-data/lib/error-messages"
import { Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import { DestinationForm, TextField, toFormState } from "./form"

// `DestinationDialog` and the `useDestinationManager` state it is driven by
// (components/alerts/destination-dialog.tsx, overview/routing-tab.tsx), as one Submodel.

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	form: DestinationForm,
	/** The destination being edited, `null` for a new one. */
	editingId: Schema.NullOr(AlertDestinationId),
	/** Opened on a provider picked elsewhere: the grid is folded behind "Change". */
	isProviderLocked: Schema.Boolean,
	isSaving: Schema.Boolean,
	/** Bumped on every open: a save's result only settles the form it was sent from. */
	openCount: Schema.Number,
	/** `chatIntegration.connectors`, `null` until it answers (`orElse(() => [])`). */
	connectors: Schema.NullOr(Schema.Array(V2ChatConnector)),
	telegramChats: Schema.NullOr(Schema.Array(V2TelegramChat)),
	telegramError: Schema.NullOr(Schema.String),
	isDetectingChats: Schema.Boolean,
	brokenLogos: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	form: defaultDestinationForm(),
	editingId: null,
	isProviderLocked: false,
	isSaving: false,
	openCount: 0,
	connectors: null,
	telegramChats: null,
	telegramError: null,
	isDetectingChats: false,
	brokenLogos: [],
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	CompletedFetchConnectors: { connectors: Schema.Array(V2ChatConnector) },
	ClickedProvider: { type: AlertDestinationType },
	ClickedChatWorkspace: { connector: Schema.String, workspaceId: Schema.String },
	ClickedUnlockProvider: {},
	ChangedField: { field: TextField, value: Schema.String },
	ToggledEnabled: {},
	ClickedDetectChats: {},
	CompletedDetectChats: { result: Schema.Result(Schema.Array(V2TelegramChat), Schema.String) },
	ClickedTelegramChat: { chatId: Schema.String },
	ClickedCancel: {},
	ClickedSave: {},
	CompletedSave: {
		openCount: Schema.Number,
		isCreate: Schema.Boolean,
		result: Schema.Result(AlertDestinationId, Schema.Struct({ title: Schema.String, message: Schema.String })),
	},
	FailedLoadProviderLogo: { type: Schema.String },
})
export type Message = typeof Message.Type

/** What the page does with the dialog's outcome: toast it, and select a created destination. */
export const OutMessage = defineMessageUnion({
	RequestedToast: { type: Schema.Literals(["success", "error"]), title: Schema.String, description: Schema.String },
	CreatedDestination: { id: AlertDestinationId },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

// COMMANDS

const FetchChatConnectors = Command.define("FetchChatConnectors", {
	messages: [Message.CompletedFetchConnectors],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.chatIntegration.connectors()
		// Slack first, as `useChatConnectors`; every connector is on for a self-hosted org.
		return Message.CompletedFetchConnectors({
			connectors: [...response.data].sort((a, b) => Number(b.id === "slack") - Number(a.id === "slack")),
		})
	}).pipe(Effect.orElseSucceed(() => Message.CompletedFetchConnectors({ connectors: [] }))),
})

const DetectTelegramChats = Command.define("DetectTelegramChats", {
	args: { botToken: Schema.String },
	messages: [Message.CompletedDetectChats],
	execute: ({ botToken }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* client.alertDestinations.telegramChats({ payload: { bot_token: botToken } })
			return result.chats
		}).pipe(
			Effect.mapError((error) => displayError(error).message),
			Effect.result,
			Effect.map((result) => Message.CompletedDetectChats({ result })),
		),
})

const failure = (error: unknown) => {
	const body = toLoadFailure(error)
	return { title: body.title, message: body.message }
}

export const CreateDestination = Command.define("CreateAlertDestination", {
	args: { openCount: Schema.Number, payload: V2AlertDestinationCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ openCount, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			// `as never`, as apps/web: the generated client collapses this union payload to one member.
			const created = yield* client.alertDestinations.create({ payload: payload as never })
			return created.id
		}).pipe(
			Effect.mapError(failure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ openCount, isCreate: true, result })),
		),
})

const UpdateDestination = Command.define("UpdateAlertDestinationFromDialog", {
	args: { openCount: Schema.Number, id: AlertDestinationId, payload: V2AlertDestinationUpdateParams },
	messages: [Message.CompletedSave],
	execute: ({ openCount, id, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const updated = yield* client.alertDestinations.update({ params: { id }, payload: payload as never })
			return updated.id
		}).pipe(
			Effect.mapError(failure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ openCount, isCreate: false, result })),
		),
})

// FORM READINESS (`isFormReady`, `isValidPagerDutyKey`, `isValidTelegramToken`)

export const isValidPagerDutyKey = (key: string): boolean => /^[A-Za-z0-9]{32}$/.test(key.trim())
export const isValidTelegramToken = (token: string): boolean => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())

export const isFormReady = (form: DestinationForm, isEditing: boolean): boolean => {
	if (isEditing && form.name.trim().length === 0) return false
	switch (form.type) {
		case "hazel-oauth":
			return form.hazelOrganizationId.trim().length > 0 && form.hazelChannelId.trim().length > 0
		case "discord":
			return isEditing || form.webhookUrl.trim().length > 0
		case "telegram":
			return form.telegramChatId.trim().length > 0 && (isEditing || form.telegramBotToken.trim().length > 0)
		case "pagerduty":
			return isEditing && form.integrationKey.trim().length === 0 ? true : isValidPagerDutyKey(form.integrationKey)
		case "email":
			return form.memberUserIds.length > 0 && form.memberUserIds.length <= MAX_EMAIL_MEMBER_RECIPIENTS
		case "chat":
			return form.chatWorkspaceId !== null && (isEditing || form.chatChannelId.length > 0)
		default:
			return true
	}
}

// UPDATE

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/** A save in flight stays in flight across a reopen (legacy's `useAsyncAction`): no second submit. */
const open = (model: Model, patch: Partial<Model>): Return => {
	const next = { ...model, ...patch, openCount: model.openCount + 1, telegramChats: null, telegramError: null }
	const opened = liftDialog(next, Dialog.open(model.dialog))
	// `ProviderPicker` reads the connectors; it renders only for a new, unlocked destination.
	const needsConnectors = next.editingId === null && !next.isProviderLocked && next.connectors === null
	return { ...opened, commands: [...(opened.commands ?? []), ...(needsConnectors ? [FetchChatConnectors()] : [])] }
}

/** `openDialog()`: a new destination, optionally preset to a provider picked elsewhere. */
export const openNew = (model: Model, preset?: DestinationForm): Return =>
	open(model, { form: preset ?? defaultDestinationForm(), editingId: null, isProviderLocked: preset !== undefined })

/** `openDialog(destination)`: edit an existing one. */
export const openEdit = (model: Model, destination: AlertDestinationDocument): Return =>
	open(model, { form: destinationToFormState(destination), editingId: destination.id, isProviderLocked: false })

const close = (model: Model): Return => liftDialog(model, Dialog.close(model.dialog))

const save = (model: Model): Return => {
	if (model.isSaving || !isFormReady(model.form, model.editingId !== null)) return { model }
	const form = toFormState(model.form)
	if (model.editingId !== null)
		return {
			model: { ...model, isSaving: true },
			commands: [
				UpdateDestination({
					openCount: model.openCount,
					id: model.editingId,
					payload: buildDestinationUpdateParamsV2(form),
				}),
			],
		}
	const named = form.name.trim().length > 0 ? form : { ...form, name: suggestedDestinationName(form) }
	return {
		model: { ...model, isSaving: true },
		commands: [CreateDestination({ openCount: model.openCount, payload: buildDestinationCreateParamsV2(named) })],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		CompletedFetchConnectors: ({ connectors }) => ({ model: { ...model, connectors } }),
		ClickedProvider: ({ type }) => ({ model: { ...model, form: defaultDestinationForm(type) } }),
		ClickedChatWorkspace: ({ connector, workspaceId }) =>
			Option.match(
				Option.flatMap(Option.fromNullishOr(model.connectors), (connectors) =>
					Option.fromNullishOr(
						connectors.flatMap((entry) => entry.workspaces).find((workspace) => workspace.id === workspaceId),
					),
				),
				{
					onNone: () => ({ model }),
					onSome: (workspace) => ({ model: { ...model, form: chatDestinationForm(connector, workspace.id) } }),
				},
			),
		ClickedUnlockProvider: () => ({ model: { ...model, isProviderLocked: false } }),
		ChangedField: ({ field, value }) => ({ model: { ...model, form: { ...model.form, [field]: value } } }),
		ToggledEnabled: () => ({ model: { ...model, form: { ...model.form, enabled: !model.form.enabled } } }),
		ClickedDetectChats: () =>
			model.isDetectingChats || !isValidTelegramToken(model.form.telegramBotToken)
				? { model }
				: {
						model: { ...model, isDetectingChats: true, telegramChats: null, telegramError: null },
						commands: [DetectTelegramChats({ botToken: model.form.telegramBotToken.trim() })],
					},
		CompletedDetectChats: ({ result }) =>
			Result.match(result, {
				onSuccess: (chats) => {
					const [only] = chats
					return {
						model: {
							...model,
							isDetectingChats: false,
							telegramChats: chats,
							form: chats.length === 1 && only !== undefined ? { ...model.form, telegramChatId: only.id } : model.form,
						},
					}
				},
				onFailure: (error) => ({ model: { ...model, isDetectingChats: false, telegramError: error } }),
			}),
		ClickedTelegramChat: ({ chatId }) => ({ model: { ...model, form: { ...model.form, telegramChatId: chatId } } }),
		ClickedCancel: () => close(model),
		ClickedSave: () => save(model),
		CompletedSave: ({ openCount, isCreate, result }) =>
			Result.match(result, {
				onSuccess: (id) => {
					// A form opened since the save was sent stays open; the outcome is still reported.
					const settled = { ...model, isSaving: false }
					const closed = openCount === model.openCount ? close(settled) : { model: settled }
					return {
						...closed,
						outMessage: isCreate
							? OutMessage.CreatedDestination({ id })
							: OutMessage.RequestedToast({ type: "success", title: "Destination updated", description: "" }),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isSaving: false },
					outMessage: OutMessage.RequestedToast({
						type: "error",
						title: "Failed to save destination",
						description: error.message,
					}),
				}),
			}),
		FailedLoadProviderLogo: ({ type }) =>
			model.brokenLogos.includes(type) ? { model } : { model: { ...model, brokenLogos: [...model.brokenLogos, type] } },
	})

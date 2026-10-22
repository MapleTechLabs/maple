import { type AlertDestinationDocument, AlertDestinationId, AlertDestinationType } from "@maple/domain/http"
import {
	V2AlertDestinationCreateParams,
	V2AlertDestinationUpdateParams,
	V2ChatConnector,
	V2TelegramChat,
} from "@maple/domain/http/v2"
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
import { Effect, Option, Result, Schema, Stream } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { ChatWorkspaceId } from "@maple/domain/primitives"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import * as ChatConnect from "../shared/chat-connect"
import * as ChatConnectStream from "../shared/chat-connect-stream"
import * as ChatFields from "./chat-fields"
import * as EmailFields from "./email-fields"
import * as HazelFields from "./hazel-fields"
import { DestinationForm, TextField, toFormState } from "./form"

// The destination dialog and the state it is driven by, as one Submodel.

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
	/** `ChatDestinationFields`: the channel list and picker of a `chat` destination. */
	chat: ChatFields.Model,
	/** `useChatWorkspaceConnect` behind the connect tiles. */
	chatConnect: ChatConnect.Model,
	/** `EmailMemberPicker`: the org's members, read from Clerk once the picker mounts. */
	email: EmailFields.Model,
	/** `HazelOAuthFields`: the connection, its organizations and the picked one's channels. */
	hazel: HazelFields.Model,
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
	chat: ChatFields.init(),
	chatConnect: ChatConnect.init(),
	email: EmailFields.init(),
	hazel: HazelFields.init(),
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
	/** Keyed by the open and the token it was sent for: a stale answer never fills a newer form. */
	CompletedDetectChats: {
		openCount: Schema.Number,
		botToken: Schema.String,
		result: Schema.Result(Schema.Array(V2TelegramChat), Schema.String),
	},
	ClickedTelegramChat: { chatId: Schema.String },
	ClickedCancel: {},
	ClickedSave: {},
	CompletedSave: {
		openCount: Schema.Number,
		isCreate: Schema.Boolean,
		result: Schema.Result(
			AlertDestinationId,
			Schema.Struct({ title: Schema.String, message: Schema.String }),
		),
	},
	FailedLoadProviderLogo: { type: Schema.String },
	GotChatFieldsMessage: { message: ChatFields.Message },
	ClickedConnectChat: { connector: Schema.String },
	GotChatConnectMessage: { message: ChatConnect.Message },
	GotEmailFieldsMessage: { message: EmailFields.Message },
	GotHazelFieldsMessage: { message: HazelFields.Message },
})
export type Message = typeof Message.Type

/** What the page does with the dialog's outcome: toast it, and select a created destination. */
export const OutMessage = defineMessageUnion({
	RequestedToast: {
		type: Schema.Literals(["success", "error"]),
		title: Schema.String,
		description: Schema.String,
	},
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
			connectors: [...response.data].sort(
				(a, b) => Number(b.id === "slack") - Number(a.id === "slack"),
			),
		})
	}).pipe(Effect.orElseSucceed(() => Message.CompletedFetchConnectors({ connectors: [] }))),
})

export const DetectTelegramChats = Command.define("DetectTelegramChats", {
	args: { openCount: Schema.Number, botToken: Schema.String },
	messages: [Message.CompletedDetectChats],
	execute: ({ openCount, botToken }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* client.alertDestinations.telegramChats({ payload: { bot_token: botToken } })
			return result.chats
		}).pipe(
			Effect.mapError((error) => displayError(error).message),
			Effect.result,
			Effect.map((result) => Message.CompletedDetectChats({ openCount, botToken, result })),
		),
})

const failure = (error: unknown) => {
	const body = toLoadFailure(error)
	return { title: body.title, message: body.message }
}

// The client takes one request shape per payload member, so the union is split on `type` here.
const createRequest = (payload: V2AlertDestinationCreateParams) => {
	switch (payload.type) {
		case "pagerduty":
			return { payload }
		case "webhook":
			return { payload }
		case "hazel-oauth":
			return { payload }
		case "discord":
			return { payload }
		case "telegram":
			return { payload }
		case "email":
			return { payload }
		case "chat":
			return { payload }
	}
}

const updateRequest = (id: AlertDestinationId, payload: V2AlertDestinationUpdateParams) => {
	const params = { id }
	switch (payload.type) {
		case "pagerduty":
			return { params, payload }
		case "webhook":
			return { params, payload }
		case "hazel-oauth":
			return { params, payload }
		case "discord":
			return { params, payload }
		case "telegram":
			return { params, payload }
		case "email":
			return { params, payload }
		case "chat":
			return { params, payload }
	}
}

export const CreateDestination = Command.define("CreateAlertDestination", {
	args: { openCount: Schema.Number, payload: V2AlertDestinationCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ openCount, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const created = yield* client.alertDestinations.create(createRequest(payload))
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
			const updated = yield* client.alertDestinations.update(updateRequest(id, payload))
			return updated.id
		}).pipe(
			Effect.mapError(failure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ openCount, isCreate: false, result })),
		),
})

// FORM READINESS (`isFormReady`, `isValidPagerDutyKey`, `isValidTelegramToken`)

export const isValidPagerDutyKey = (key: string): boolean => /^[A-Za-z0-9]{32}$/.test(key.trim())
export const isValidTelegramToken = (token: string): boolean =>
	/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())

export const isFormReady = (form: DestinationForm, isEditing: boolean): boolean => {
	if (isEditing && form.name.trim().length === 0) return false
	switch (form.type) {
		case "hazel-oauth":
			return form.hazelOrganizationId.trim().length > 0 && form.hazelChannelId.trim().length > 0
		case "discord":
			return isEditing || form.webhookUrl.trim().length > 0
		case "telegram":
			return (
				form.telegramChatId.trim().length > 0 &&
				(isEditing || form.telegramBotToken.trim().length > 0)
			)
		case "pagerduty":
			return isEditing && form.integrationKey.trim().length === 0
				? true
				: isValidPagerDutyKey(form.integrationKey)
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

const withCommands = (step: Return, commands: Return["commands"]): Return => ({
	...step,
	commands: [...(step.commands ?? []), ...(commands ?? [])],
})

const liftChat = (model: Model, step: ChatFields.Return): Return => ({
	model: {
		...model,
		chat: step.model,
		form: step.form === undefined ? model.form : { ...model.form, ...step.form },
	},
	commands: Command.mapMessages(step.commands, (message) => Message.GotChatFieldsMessage({ message })),
})

const liftEmail = (model: Model, step: EmailFields.Return): Return => ({
	model: {
		...model,
		email: step.model,
		form: step.form === undefined ? model.form : { ...model.form, ...step.form },
	},
	commands: Command.mapMessages(step.commands, (message) => Message.GotEmailFieldsMessage({ message })),
})

const liftHazel = (model: Model, step: HazelFields.Return): Return => ({
	model: {
		...model,
		hazel: step.model,
		form: step.form === undefined ? model.form : { ...model.form, ...step.form },
	},
	commands: Command.mapMessages(step.commands, (message) => Message.GotHazelFieldsMessage({ message })),
})

/** The provider's own fields mount with the form: a chat channel list, or the email members, load. */
const mountFields = (step: Return): Return => {
	const { form } = step.model
	if (form.type === "chat")
		return withCommands(liftChat(step.model, ChatFields.reset(step.model.chat, form)), step.commands)
	if (form.type === "hazel-oauth")
		return withCommands(liftHazel(step.model, HazelFields.reset(step.model.hazel, form)), step.commands)
	if (form.type === "email" && isClerkAuthEnabled)
		return withCommands(liftEmail(step.model, EmailFields.reset(step.model.email, form)), step.commands)
	return step
}

/** A save in flight stays in flight across a reopen: no second submit. */
const open = (model: Model, patch: Partial<Model>): Return => {
	const next = {
		...model,
		...patch,
		openCount: model.openCount + 1,
		telegramChats: null,
		telegramError: null,
		isDetectingChats: false,
		chatConnect: ChatConnect.finish(model.chatConnect),
	}
	const opened = liftDialog(next, Dialog.open(model.dialog))
	// `ProviderPicker` reads the connectors; it renders only for a new, unlocked destination.
	const needsConnectors = next.editingId === null && !next.isProviderLocked && next.connectors === null
	return mountFields(withCommands(opened, needsConnectors ? [FetchChatConnectors()] : []))
}

/** A chat workspace picked, or just linked in the popup: the form posts to one of its channels. */
const pickChatWorkspace = (model: Model, connector: string, workspaceId: ChatWorkspaceId): Return =>
	mountFields({ model: { ...model, form: chatDestinationForm(connector, workspaceId) } })

const connectChat = (model: Model, connectorId: string): Return =>
	Option.match(Option.fromNullishOr((model.connectors ?? []).find((entry) => entry.id === connectorId)), {
		onNone: () => ({ model }),
		onSome: (connector) =>
			ChatConnect.waitingFor(model.chatConnect) !== null
				? { model }
				: { model: { ...model, chatConnect: ChatConnect.start(model.chatConnect, connector) } },
	})

const chatConnectStep = (model: Model, message: ChatConnect.Message): Return => {
	const step = ChatConnect.update(model.chatConnect, message)
	return {
		model: { ...model, chatConnect: step.model },
		commands: step.isRefetching ? [FetchChatConnectors()] : [],
		...Option.match(step.toast, {
			onNone: () => ({}),
			onSome: ({ title, description }) => ({
				outMessage: OutMessage.RequestedToast({ type: "error", title, description }),
			}),
		}),
	}
}

/** `onLinked`: the new workspace becomes the form's, and the popup closes. */
const connectorsAnswered = (model: Model, connectors: ReadonlyArray<V2ChatConnector>): Return => {
	const next = { ...model, connectors }
	return Option.match(ChatConnect.linkedOf(model.chatConnect, connectors), {
		onNone: () => ({ model: next }),
		onSome: (linked) =>
			pickChatWorkspace(
				{ ...next, chatConnect: ChatConnect.finish(next.chatConnect) },
				linked.connector,
				linked.id,
			),
	})
}

/** `openDialog()`: a new destination, optionally preset to a provider picked elsewhere. */
export const openNew = (model: Model, preset?: DestinationForm): Return =>
	open(model, {
		form: preset ?? defaultDestinationForm(),
		editingId: null,
		isProviderLocked: preset !== undefined,
	})

/** `openDialog(destination)`: edit an existing one. */
export const openEdit = (model: Model, destination: AlertDestinationDocument): Return =>
	open(model, {
		form: destinationToFormState(destination),
		editingId: destination.id,
		isProviderLocked: false,
	})

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
		commands: [
			CreateDestination({ openCount: model.openCount, payload: buildDestinationCreateParamsV2(named) }),
		],
	}
}

/** One chat is the common case (the bot was just added to a group): it fills the field. */
const detected = (model: Model, result: Result.Result<ReadonlyArray<V2TelegramChat>, string>): Return =>
	Result.match(result, {
		onSuccess: (chats) => {
			const [only] = chats
			return {
				model: {
					...model,
					isDetectingChats: false,
					telegramChats: chats,
					form:
						chats.length === 1 && only !== undefined
							? { ...model.form, telegramChatId: only.id }
							: model.form,
				},
			}
		},
		onFailure: (error) => ({ model: { ...model, isDetectingChats: false, telegramError: error } }),
	})

// SUBSCRIPTION (the host page runs it: a Submodel has no Subscriptions of its own)

/** The connect popup lives with the open dialog. */
export const chatConnectDependencies = (model: Model): ChatConnectStream.Dependencies =>
	ChatConnectStream.dependenciesOf(model.chatConnect, model.dialog.isOpen)

export const chatConnectStream = (dependencies: ChatConnectStream.Dependencies) =>
	Stream.map(ChatConnectStream.streamOf(dependencies), (message) =>
		Message.GotChatConnectMessage({ message }),
	)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		CompletedFetchConnectors: ({ connectors }) => connectorsAnswered(model, connectors),
		ClickedProvider: ({ type }) =>
			mountFields({ model: { ...model, form: defaultDestinationForm(type) } }),
		ClickedChatWorkspace: ({ connector, workspaceId }) =>
			Option.match(
				Option.flatMap(Option.fromNullishOr(model.connectors), (connectors) =>
					Option.fromNullishOr(
						connectors
							.flatMap((entry) => entry.workspaces)
							.find((workspace) => workspace.id === workspaceId),
					),
				),
				{
					onNone: () => ({ model }),
					onSome: (workspace) => pickChatWorkspace(model, connector, workspace.id),
				},
			),
		ClickedUnlockProvider: () => ({ model: { ...model, isProviderLocked: false } }),
		ChangedField: ({ field, value }) => ({
			model: { ...model, form: { ...model.form, [field]: value } },
		}),
		ToggledEnabled: () => ({
			model: { ...model, form: { ...model.form, enabled: !model.form.enabled } },
		}),
		ClickedDetectChats: () =>
			model.isDetectingChats || !isValidTelegramToken(model.form.telegramBotToken)
				? { model }
				: {
						model: { ...model, isDetectingChats: true, telegramChats: null, telegramError: null },
						commands: [
							DetectTelegramChats({
								openCount: model.openCount,
								botToken: model.form.telegramBotToken.trim(),
							}),
						],
					},
		CompletedDetectChats: ({ openCount, botToken, result }) =>
			openCount !== model.openCount
				? { model }
				: botToken !== model.form.telegramBotToken.trim()
					? { model: { ...model, isDetectingChats: false } }
					: detected(model, result),
		ClickedTelegramChat: ({ chatId }) => ({
			model: { ...model, form: { ...model.form, telegramChatId: chatId } },
		}),
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
							: OutMessage.RequestedToast({
									type: "success",
									title: "Destination updated",
									description: "",
								}),
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
			model.brokenLogos.includes(type)
				? { model }
				: { model: { ...model, brokenLogos: [...model.brokenLogos, type] } },
		GotChatFieldsMessage: ({ message: inner }) =>
			liftChat(model, ChatFields.update(model.chat, inner, model.form)),
		ClickedConnectChat: ({ connector }) => connectChat(model, connector),
		GotChatConnectMessage: ({ message: inner }) => chatConnectStep(model, inner),
		GotEmailFieldsMessage: ({ message: inner }) =>
			liftEmail(model, EmailFields.update(model.email, inner)),
		GotHazelFieldsMessage: ({ message: inner }) =>
			liftHazel(model, HazelFields.update(model.hazel, inner, model.form)),
	})

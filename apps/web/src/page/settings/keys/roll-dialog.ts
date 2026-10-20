import { ApiKeyId } from "@maple/domain/http"
import { V2ApiKey } from "@maple/domain/http/v2"
import { Effect, Result, Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { secretReveal } from "./secret-reveal"

// `RollApiKeyDialog`.

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	apiKey: Schema.NullOr(V2ApiKey),
	isRolling: Schema.Boolean,
	newSecret: Schema.NullOr(Schema.String),
	secretCopy: CopyButton.Model,
	isSecretVisible: Schema.Boolean,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	apiKey: null,
	isRolling: false,
	newSecret: null,
	secretCopy: CopyButton.init(),
	isSecretVisible: false,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ClickedCancel: {},
	ClickedRoll: {},
	CompletedRoll: { result: Schema.Result(Schema.String, LoadFailure) },
	GotSecretCopyMessage: { message: CopyButton.Message },
	ToggledSecretVisible: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	RequestedToast: { type: Schema.Literals(["error"]), title: Schema.String, description: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const RollApiKey = Command.define("RollApiKey", {
	args: { id: ApiKeyId },
	messages: [Message.CompletedRoll],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const rolled = yield* client.apiKeys.roll({ params: { id } })
			return rolled.secret
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedRoll({ result })),
		),
})

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

const reset = (model: Model): Model => ({ ...init(model.dialog.id), apiKey: model.apiKey, dialog: model.dialog })

export const open = (model: Model, apiKey: V2ApiKey): Return =>
	liftDialog({ ...reset(model), apiKey }, Dialog.open(model.dialog))

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		// A roll in flight cannot be dismissed: the one-time secret would land in a closed dialog.
		GotDialogMessage: ({ message: child }) => {
			if (model.isRolling) return { model }
			const step = Dialog.update(model.dialog, child)
			return liftDialog(step.outMessage?._tag === "Closed" ? reset(model) : model, step)
		},
		ClickedCancel: () => (model.isRolling ? { model } : liftDialog(reset(model), Dialog.close(model.dialog))),
		ClickedRoll: () =>
			model.isRolling || model.apiKey === null
				? { model }
				: { model: { ...model, isRolling: true }, commands: [RollApiKey({ id: model.apiKey.id })] },
		CompletedRoll: ({ result }) =>
			Result.match(result, {
				onSuccess: (secret) => ({ model: { ...model, isRolling: false, newSecret: secret } }),
				onFailure: (error) => ({
					model: { ...model, isRolling: false },
					outMessage: OutMessage.RequestedToast({
						type: "error",
						title: "Failed to roll API key",
						description: error.message,
					}),
				}),
			}),
		GotSecretCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.secretCopy, child)
			return {
				model: { ...model, secretCopy: step.model },
				commands: Command.mapMessages(step.commands, (inner) => Message.GotSecretCopyMessage({ message: inner })),
			}
		},
		ToggledSecretVisible: () => ({ model: { ...model, isSecretVisible: !model.isSecretVisible } }),
	})

export const view = Submodel.defineView<Model, Message, Readonly<{ slotId: string }>>((model, inputs, h) =>
	h.submodel({
		slotId: inputs.slotId,
		model: model.dialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () =>
				model.newSecret === null
					? [
							DialogView.dialogHeader(h, "dialog", [
								DialogView.dialogTitle(h, "dialog", model.dialog.id, "Roll API key?"),
								DialogView.dialogDescription(h, "dialog", model.dialog.id, [
									"A new secret will be issued for",
									" ",
									h.span([h.Class("text-foreground font-medium")], [model.apiKey?.name ?? ""]),
									" and the current key will be revoked immediately. Any integrations using the old key will stop working until you update them with the new one.",
								]),
							]),
							DialogView.dialogFooter(h, "dialog", [
								button(
									h,
									{ variant: "outline", isDisabled: model.isRolling, attributes: [h.OnClick(Message.ClickedCancel())] },
									["Cancel"],
								),
								button(
									h,
									{ variant: "destructive", isLoading: model.isRolling, attributes: [h.OnClick(Message.ClickedRoll())] },
									["Roll key"],
								),
							]),
						]
					: [
							DialogView.dialogHeader(h, "dialog", [
								DialogView.dialogTitle(h, "dialog", model.dialog.id, "API key rolled"),
								DialogView.dialogDescription(
									h,
									"dialog",
									model.dialog.id,
									"A new secret has been issued and the previous key was revoked. Copy your new key now; you won't be able to see it again.",
								),
							]),
							DialogView.dialogPanel(h, "dialog", model.dialog.id, [
								secretReveal(h, {
									id: "api-key-rolled-secret",
									secret: model.newSecret,
									copy: model.secretCopy,
									toCopyMessage: (message) => Message.GotSecretCopyMessage({ message }),
									isVisible: model.isSecretVisible,
									onToggle: Message.ToggledSecretVisible(),
								}),
							]),
							DialogView.dialogFooter(h, "dialog", [
								button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedCancel())] }, ["Done"]),
							]),
						],
		},
	}),
)

import { V2SupportChannel } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../data/analytics"
import { LoadFailure, toLoadFailure } from "../data/load-failure"
import { MapleApiV2Client } from "../platform/api-clients"
import type { Resources } from "../platform/resources"
import * as Dialog from "../ui/dialog"

// The support channel dialog: the shared Slack
// channel with the Maple team, read when the dialog opens; one button creates it or invites you.

export const ChannelData = AsyncData.Schema(V2SupportChannel, LoadFailure)

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	channel: ChannelData.schema,
	/** The invite that was just sent: the body switches to "Invite sent to ...". */
	invited: Schema.NullOr(V2SupportChannel),
	isInviting: Schema.Boolean,
	inviteError: Schema.NullOr(LoadFailure),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	dialog: Dialog.init("shell-support-channel", "dialog"),
	channel: ChannelData.Idle(),
	invited: null,
	isInviting: false,
	inviteError: null,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	SucceededLoadChannel: { channel: V2SupportChannel },
	FailedLoadChannel: { failure: LoadFailure },
	ClickedRetry: {},
	ClickedInvite: {},
	SucceededInvite: { channel: V2SupportChannel },
	FailedInvite: { failure: LoadFailure },
})
export type Message = typeof Message.Type

export const LoadChannel = Command.define("LoadSupportChannel", {
	messages: [Message.SucceededLoadChannel, Message.FailedLoadChannel],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const channel = yield* client.supportChannel.retrieve()
		return Message.SucceededLoadChannel({ channel })
	}).pipe(Effect.catch((error) => Effect.succeed(Message.FailedLoadChannel({ failure: toLoadFailure(error) })))),
})

type UpdateReturn = Update.Return<Model, Message, Resources>

const toDialog = (message: Dialog.Message) => Message.GotDialogMessage({ message })

/** The body mounts with the dialog: a channel not read yet (or failed) is read then. */
const withDialog = (model: Model, step: ReturnType<typeof Dialog.update>): UpdateReturn => {
	const commands = Command.mapMessages(step.commands ?? [], toDialog)
	const out = step.outMessage
	if (out !== undefined && out._tag === "Opened" && (AsyncData.isIdle(model.channel) || AsyncData.isFailure(model.channel)))
		return {
			model: { ...model, dialog: step.model, channel: ChannelData.Loading() },
			commands: [...commands, LoadChannel()],
		}
	if (out !== undefined && out._tag === "Closed")
		return { model: { ...model, dialog: step.model, invited: null, inviteError: null }, commands }
	return { model: { ...model, dialog: step.model }, commands }
}

export const open = (model: Model): UpdateReturn => withDialog(model, Dialog.open(model.dialog))

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotDialogMessage: ({ message: child }) => withDialog(model, Dialog.update(model.dialog, child)),
		SucceededLoadChannel: ({ channel }) => ({ model: { ...model, channel: ChannelData.Success({ data: channel }) } }),
		FailedLoadChannel: ({ failure }) => ({ model: { ...model, channel: ChannelData.Failure({ error: failure }) } }),
		ClickedRetry: () => ({ model: { ...model, channel: ChannelData.Loading() }, commands: [LoadChannel()] }),
		ClickedInvite: () =>
			model.isInviting
				? { model }
				: { model: { ...model, isInviting: true, inviteError: null }, commands: [InviteToChannel()] },
		// The invite answers with the channel; the read is refreshed behind it.
		SucceededInvite: ({ channel }) => ({
			model: { ...model, isInviting: false, invited: channel },
			commands: [LoadChannel()],
		}),
		FailedInvite: ({ failure }) => ({ model: { ...model, isInviting: false, inviteError: failure } }),
	})

export const InviteToChannel = Command.define("InviteToSupportChannel", {
	messages: [Message.SucceededInvite, Message.FailedInvite],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const channel = yield* client.supportChannel.invite()
		// `support_channel_invite_sent` once the invite went out.
		yield* trackProduct("support_channel_invite_sent")
		return Message.SucceededInvite({ channel })
	}).pipe(Effect.catch((error) => Effect.succeed(Message.FailedInvite({ failure: toLoadFailure(error) })))),
})

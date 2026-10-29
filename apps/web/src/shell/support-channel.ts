import { V2SupportChannel } from "@maple/domain/http/v2"
import { Effect, Layer, Schema, Tuple } from "effect"
import { AsyncData, Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../data/analytics"
import { LoadFailure, toLoadFailure } from "../data/load-failure"
import { MapleApiV2Client } from "../platform/api-clients"
import { DialogBlock } from "../ui/dialog-view"
import { MountNetworkAutoRetry } from "../ui/error-state"

// The support channel dialog: the shared Slack
// channel with the Maple team, read when the dialog opens; one button creates it or invites you.

export const ChannelData = AsyncData.Schema(V2SupportChannel, LoadFailure)

export const DIALOG_ID = "shell-support-channel"

export const Model = Schema.Struct({
	dialog: DialogBlock.Model,
	channel: ChannelData.schema,
	/** The invite that was just sent: the body switches to "Invite sent to ...". */
	invited: Schema.NullOr(V2SupportChannel),
	isInviting: Schema.Boolean,
	inviteError: Schema.NullOr(LoadFailure),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	/** Operation: the Support menu's item opens the dialog. */
	RequestedOpen: {},
	SucceededLoadChannel: { channel: V2SupportChannel },
	FailedLoadChannel: { failure: LoadFailure },
	ClickedRetry: {},
	ClickedInvite: {},
	SucceededInvite: { channel: V2SupportChannel },
	FailedInvite: { failure: LoadFailure },
})
export type Message = typeof Message.Type

export const SupportChannelDefinition = Block.makeDefinition("SupportChannel", { Model, Message })
const { makeStep } = SupportChannelDefinition

export const LoadChannel = SupportChannelDefinition.makeCommand("LoadSupportChannel", {
	messages: [Message.SucceededLoadChannel, Message.FailedLoadChannel],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const channel = yield* client.supportChannel.retrieve()
				return Message.SucceededLoadChannel({ channel })
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed(Message.FailedLoadChannel({ failure: toLoadFailure(error) })),
				),
			)
	},
})

export const InviteToChannel = SupportChannelDefinition.makeCommand("InviteToSupportChannel", {
	messages: [Message.SucceededInvite, Message.FailedInvite],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const channel = yield* client.supportChannel.invite()
				// `support_channel_invite_sent` once the invite went out.
				yield* trackProduct("support_channel_invite_sent")
				return Message.SucceededInvite({ channel })
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed(Message.FailedInvite({ failure: toLoadFailure(error) })),
				),
			)
	},
})

/** The body mounts with the dialog: a channel not read yet (or failed) is read then; a close forgets the invite. */
export const DialogBinding = SupportChannelDefinition.makeBinding(DialogBlock, {
	field: "dialog",
	init: { contextToArgs: () => Tuple.make(DIALOG_ID, "dialog") },
}).withOutMessagePolicy({
	fold: SupportChannelDefinition.makeOutMessageFold(DialogBlock, {
		Opened: () =>
			makeStep((model) =>
				AsyncData.isIdle(model.channel) || AsyncData.isFailure(model.channel)
					? { model: { ...model, channel: ChannelData.Loading() }, commands: [LoadChannel()] }
					: { model },
			),
		Closed: () => makeStep((model) => ({ model: { ...model, invited: null, inviteError: null } })),
	}),
})

export const SupportChannelComposition = SupportChannelDefinition.makeComposition({
	bindings: [DialogBinding],
	mounts: [MountNetworkAutoRetry],
})
export type SupportChannelViewBuilder = Block.ViewBuilderFor<typeof SupportChannelComposition>

export const init = SupportChannelComposition.makeInit(() => ({
	model: { channel: ChannelData.Idle(), invited: null, isInviting: false, inviteError: null },
}))

export const update = SupportChannelComposition.makeUpdate({
	RequestedOpen: (model) => DialogBinding.requestOpen()(model),
	SucceededLoadChannel: (model, { channel }) => ({
		model: { ...model, channel: ChannelData.Success({ data: channel }) },
	}),
	FailedLoadChannel: (model, { failure }) => ({
		model: { ...model, channel: ChannelData.Failure({ error: failure }) },
	}),
	ClickedRetry: (model) => ({
		model: { ...model, channel: ChannelData.Loading() },
		commands: [LoadChannel()],
	}),
	ClickedInvite: (model) =>
		model.isInviting
			? { model }
			: { model: { ...model, isInviting: true, inviteError: null }, commands: [InviteToChannel()] },
	// The invite answers with the channel; the read is refreshed behind it.
	SucceededInvite: (model, { channel }) => ({
		model: { ...model, isInviting: false, invited: channel },
		commands: [LoadChannel()],
	}),
	FailedInvite: (model, { failure }) => ({ model: { ...model, isInviting: false, inviteError: failure } }),
})

/** Every handler this Block owns; the Dialog's travel with its Binding. */
export const EffectsLayer = Layer.mergeAll(
	LoadChannel.layer,
	InviteToChannel.layer,
	MountNetworkAutoRetry.layer,
)

export const operations = { requestOpen: Message.RequestedOpen }

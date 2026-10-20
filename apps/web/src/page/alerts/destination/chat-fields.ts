import { V2ChatDestination } from "@maple/domain/http/v2"
import { ChatWorkspaceId } from "@maple/domain/primitives"
import { channelLabel } from "../../../components/alerts/channel-search"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Keyed from "../../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Combobox from "../../../ui/combobox"
import type { DestinationForm } from "./form"

// `ChatDestinationFields`: the channel a `chat`
// destination posts to, from what the workspace's connector says the bot can post in.

export const Model = Schema.Struct({
	channels: Keyed.KeyedSchema(Schema.Array(V2ChatDestination), LoadFailure),
	/** Single mode over channel labels: Base UI writes the picked label into the input. */
	combobox: Combobox.Model,
})
export type Model = typeof Model.Type

/** One dialog is open at a time, so the picker keeps a fixed id. */
export const CHANNEL_COMBOBOX_ID = "destination-chat-channel"

export const init = (): Model => ({
	channels: Keyed.idle(),
	combobox: Combobox.init(CHANNEL_COMBOBOX_ID, "single"),
})

export const Message = defineMessageUnion({
	CompletedFetchChannels: { key: Schema.String, result: Schema.Result(Schema.Array(V2ChatDestination), LoadFailure) },
	ClickedRefreshChannels: {},
	GotComboboxMessage: { message: Combobox.Message },
})
export type Message = typeof Message.Type

export const FetchChatChannels = Command.define("FetchAlertChatChannels", {
	args: { key: Schema.String, workspaceId: ChatWorkspaceId },
	messages: [Message.CompletedFetchChannels],
	execute: ({ key, workspaceId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.chatIntegration.destinations({ params: { id: workspaceId } })
			return response.destinations
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchChannels({ key, result })),
		),
})

export type Return = Readonly<{
	model: Model
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	/** A picked channel, for the form. */
	form?: Partial<DestinationForm>
}>

/** Scoped like an org key by the workspace: another workspace's list is never shown meanwhile. */
const keyOf = (workspaceId: ChatWorkspaceId) => `${workspaceId}\u0000chatIntegration.destinations`

/** The workspace's channels: read once per workspace (`Load`), again on Refresh. */
export const load = (model: Model, workspaceId: ChatWorkspaceId | null, mode: Keyed.RequestMode): Return => {
	if (workspaceId === null) return { model, commands: [] }
	const key = keyOf(workspaceId)
	return Option.match(Keyed.request(model.channels, key, mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (channels) => ({ model: { ...model, channels }, commands: [FetchChatChannels({ key, workspaceId })] }),
	})
}

/** A failed refetch keeps the last list, as the other channel pickers do. */
export const channelsOf = (model: Model): ReadonlyArray<V2ChatDestination> =>
	Option.getOrElse(AsyncData.getData(model.channels.data), () => [])

export const labelOf = (channel: V2ChatDestination): string =>
	channelLabel({ name: channel.name, is_private: channel.private })

/** The input holds the selection's label, which the list reads as no query. */
const echoing = (combobox: Combobox.Model, label: string): Combobox.Model => ({
	...combobox,
	inputValue: label,
	selected: label === "" ? [] : [label],
})

/** Opening the fields: the input reads the stored channel, and its workspace's list loads. */
export const reset = (model: Model, form: DestinationForm): Return =>
	load(
		{ ...model, combobox: echoing(Combobox.init(model.combobox.id, "single"), selectedLabel(model, form)) },
		form.type === "chat" ? form.chatWorkspaceId : null,
		"Load",
	)

export const update = (model: Model, message: Message, form: DestinationForm): Return =>
	Message.match<Return>(message, {
		CompletedFetchChannels: ({ key, result }) => {
			const channels = Keyed.accept(model.channels, key, result)
			const next = { ...model, channels }
			// The stored channel's label is known once its list answers (`itemToStringLabel`).
			const isEchoing = model.combobox.inputValue === selectedLabel(model, form)
			return {
				model: isEchoing ? { ...next, combobox: echoing(next.combobox, selectedLabel(next, form)) } : next,
				commands: [],
			}
		},
		ClickedRefreshChannels: () => load(model, form.chatWorkspaceId, "Refresh"),
		GotComboboxMessage: ({ message: inner }) => {
			const step = Combobox.update(model.combobox, inner)
			const next = { ...model, combobox: step.model }
			const commands = Command.mapMessages(step.commands ?? [], (child) => Message.GotComboboxMessage({ message: child }))
			const out = step.outMessage
			const picked =
				out?._tag === "ChangedValue"
					? Option.fromNullishOr(channelsOf(model).find((channel) => labelOf(channel) === out.value))
					: Option.none()
			return Option.match(picked, {
				onNone: () => ({ model: next, commands }),
				onSome: (channel) => ({
					model: next,
					commands,
					form: { chatChannelId: channel.id, chatChannelName: channel.name },
				}),
			})
		},
	})

/** The form's channel as the input shows it: its label, or `#name` / the id when not listed. */
export const selectedLabel = (model: Model, form: DestinationForm): string =>
	Option.match(Option.fromNullishOr(channelsOf(model).find((channel) => channel.id === form.chatChannelId)), {
		onNone: () => (form.chatChannelId === "" ? "" : `#${form.chatChannelName || form.chatChannelId}`),
		onSome: labelOf,
	})

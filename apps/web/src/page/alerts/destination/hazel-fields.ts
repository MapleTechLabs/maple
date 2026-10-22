import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Keyed from "../../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import { currentReturnPath, startConnect } from "../../integrations/connect"
import type { DestinationForm } from "./form"

// `HazelOAuthFields`: connect Hazel over OAuth, then pick
// the organization and channel this destination posts into.

export const HazelStatus = Schema.Struct({ connected: Schema.Boolean, account: Schema.String })
export const HazelOrganization = Schema.Struct({ id: Schema.String, name: Schema.String, logoUrl: Schema.NullOr(Schema.String) })
export type HazelOrganization = typeof HazelOrganization.Type
export const HazelChannel = Schema.Struct({ id: Schema.String, name: Schema.String, isPrivate: Schema.Boolean })
export type HazelChannel = typeof HazelChannel.Type

export const Model = Schema.Struct({
	status: Keyed.KeyedSchema(HazelStatus, LoadFailure),
	organizations: Keyed.KeyedSchema(Schema.Array(HazelOrganization), LoadFailure),
	channels: Keyed.KeyedSchema(Schema.Array(HazelChannel), LoadFailure),
	organizationSelect: Select.Model,
	channelSelect: Select.Model,
	confirmDisconnect: Dialog.Model,
	isConnecting: Schema.Boolean,
	isDisconnecting: Schema.Boolean,
})
export type Model = typeof Model.Type

export const ORGANIZATION_SELECT_ID = "destination-hazel-organization"
export const CHANNEL_SELECT_ID = "destination-hazel-channel"

export const init = (): Model => ({
	status: Keyed.idle(),
	organizations: Keyed.idle(),
	channels: Keyed.idle(),
	organizationSelect: Select.init(ORGANIZATION_SELECT_ID, { value: "", selectedIndex: null }),
	channelSelect: Select.init(CHANNEL_SELECT_ID, { value: "", selectedIndex: null }),
	confirmDisconnect: Dialog.init("destination-hazel-disconnect", "alert-dialog"),
	isConnecting: false,
	isDisconnecting: false,
})

export const Message = defineMessageUnion({
	CompletedFetchStatus: { key: Schema.String, result: Schema.Result(HazelStatus, LoadFailure) },
	CompletedFetchOrganizations: { key: Schema.String, result: Schema.Result(Schema.Array(HazelOrganization), LoadFailure) },
	CompletedFetchChannels: { key: Schema.String, result: Schema.Result(Schema.Array(HazelChannel), LoadFailure) },
	ClickedConnect: {},
	CompletedConnect: { isStarted: Schema.Boolean },
	ClickedDisconnect: {},
	ConfirmedDisconnect: {},
	CompletedDisconnect: {},
	GotConfirmMessage: { message: Dialog.Message },
	GotOrganizationSelectMessage: { message: Select.Message },
	GotChannelSelectMessage: { message: Select.Message },
})
export type Message = typeof Message.Type

const settle = <A, R>(effect: Effect.Effect<A, unknown, R>) => Effect.result(Effect.mapError(effect, toLoadFailure))

const FetchStatus = Command.define("FetchAlertHazelStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchStatus],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const status = yield* client.integrations.hazelStatus()
			return { connected: status.connected, account: status.externalUserEmail ?? status.externalUserId ?? "Authorized" }
		}).pipe(settle, Effect.map((result) => Message.CompletedFetchStatus({ key, result }))),
})

const FetchOrganizations = Command.define("FetchAlertHazelOrganizations", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchOrganizations],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.hazelOrganizations()
			return response.organizations.map((org) => ({ id: org.id, name: org.name, logoUrl: org.logoUrl }))
		}).pipe(settle, Effect.map((result) => Message.CompletedFetchOrganizations({ key, result }))),
})

const FetchChannels = Command.define("FetchAlertHazelChannels", {
	args: { key: Schema.String, organizationId: Schema.String },
	messages: [Message.CompletedFetchChannels],
	execute: ({ key, organizationId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.hazelChannels({ params: { organizationId } })
			return response.channels.map((channel) => ({ id: channel.id, name: channel.name, isPrivate: channel.type === "private" }))
		}).pipe(settle, Effect.map((result) => Message.CompletedFetchChannels({ key, result }))),
})

const WINDOW_NAME = "maple-hazel-connect"
const WINDOW_FEATURES = "popup,width=520,height=640"

/** `handleConnect`: the popup opens in the click, then goes to the authorize URL once it is known. */
export const ConnectHazel = Command.define("ConnectAlertHazel", {
	messages: [Message.CompletedConnect],
	execute: Effect.gen(function* () {
		const popup = yield* Effect.sync(() => window.open("", WINDOW_NAME, WINDOW_FEATURES))
		const returnTo = yield* currentReturnPath
		const started = yield* Effect.result(startConnect("hazel", returnTo))
		if (started._tag === "Failure") {
			yield* Effect.sync(() => popup?.close())
			return Message.CompletedConnect({ isStarted: false })
		}
		const url = started.success.redirectUrl
		yield* Effect.sync(() => {
			if (popup !== null) popup.location.href = url
			else window.open(url, WINDOW_NAME, WINDOW_FEATURES)
		})
		return Message.CompletedConnect({ isStarted: true })
	}),
})

const DisconnectHazel = Command.define("DisconnectAlertHazel", {
	messages: [Message.CompletedDisconnect],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		yield* client.integrations.hazelDisconnect()
	}).pipe(Effect.ignore, Effect.as(Message.CompletedDisconnect())),
})

export type Return = Readonly<{
	model: Model
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	form?: Partial<DestinationForm>
}>

const STATUS_KEY = "hazel\u0000integrations.hazelStatus"
const ORGANIZATIONS_KEY = "hazel\u0000integrations.hazelOrganizations"
const channelsKey = (organizationId: string) => `${organizationId}\u0000integrations.hazelChannels`

type Step = Readonly<{ patch: Partial<Model>; command: Command.Command<Message, never, Resources> }>

const slot = <A>(
	current: Keyed.Keyed<A, LoadFailure>,
	key: string,
	mode: Keyed.RequestMode,
	toPatch: (next: Keyed.Keyed<A, LoadFailure>) => Partial<Model>,
	command: Command.Command<Message, never, Resources>,
): ReadonlyArray<Step> =>
	Option.match(Keyed.request(current, key, mode), { onNone: () => [], onSome: (next) => [{ patch: toPatch(next), command }] })

/** The three reads, as their atoms: `Refresh` is the mutations' `reactivityKeys` invalidation. */
const reads = (model: Model, organizationId: string, mode: Keyed.RequestMode): Return => {
	const steps = [
		...slot(model.status, STATUS_KEY, mode, (status) => ({ status }), FetchStatus({ key: STATUS_KEY })),
		...slot(model.organizations, ORGANIZATIONS_KEY, mode, (organizations) => ({ organizations }), FetchOrganizations({ key: ORGANIZATIONS_KEY })),
		...(organizationId === ""
			? []
			: slot(model.channels, channelsKey(organizationId), mode, (channels) => ({ channels }), FetchChannels({ key: channelsKey(organizationId), organizationId }))),
	]
	return {
		model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
		commands: steps.map((step) => step.command),
	}
}

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, confirmDisconnect: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotConfirmMessage({ message })),
})

const liftSelect = (
	model: Model,
	field: "organizationSelect" | "channelSelect",
	step: ReturnType<typeof Select.update>,
	toMessage: (message: Select.Message) => Message,
): Return => ({ model: { ...model, [field]: step.model }, commands: Command.mapMessages(step.commands ?? [], toMessage) })

const withCommands = (step: Return, commands: Return["commands"]): Return => ({ ...step, commands: [...step.commands, ...commands] })

const CLEARED: Partial<DestinationForm> = {
	hazelOrganizationId: "",
	hazelOrganizationName: "",
	hazelOrganizationLogoUrl: null,
	hazelChannelId: "",
	hazelChannelName: "",
}

export const update = (model: Model, message: Message, form: DestinationForm): Return =>
	Message.match<Return>(message, {
		CompletedFetchStatus: ({ key, result }) => ({ model: { ...model, status: Keyed.accept(model.status, key, result) }, commands: [] }),
		CompletedFetchOrganizations: ({ key, result }) => ({
			model: { ...model, organizations: Keyed.accept(model.organizations, key, result) },
			commands: [],
		}),
		CompletedFetchChannels: ({ key, result }) => ({ model: { ...model, channels: Keyed.accept(model.channels, key, result) }, commands: [] }),
		ClickedConnect: () =>
			model.isConnecting ? { model, commands: [] } : { model: { ...model, isConnecting: true }, commands: [ConnectHazel()] },
		CompletedConnect: ({ isStarted }) => {
			const settled = { ...model, isConnecting: false }
			return isStarted ? reads(settled, form.hazelOrganizationId.trim(), "Refresh") : { model: settled, commands: [] }
		},
		ClickedDisconnect: () => liftDialog(model, Dialog.open(model.confirmDisconnect)),
		ConfirmedDisconnect: () =>
			model.isDisconnecting
				? { model, commands: [] }
				: withCommands(liftDialog({ ...model, isDisconnecting: true }, Dialog.close(model.confirmDisconnect)), [DisconnectHazel()]),
		CompletedDisconnect: () => ({ ...reads({ ...model, isDisconnecting: false }, form.hazelOrganizationId.trim(), "Refresh"), form: CLEARED }),
		GotConfirmMessage: ({ message: inner }) => liftDialog(model, Dialog.update(model.confirmDisconnect, inner)),
		GotOrganizationSelectMessage: ({ message: inner }) => {
			const step = Select.update(model.organizationSelect, inner)
			const lifted = liftSelect(model, "organizationSelect", step, (child) => Message.GotOrganizationSelectMessage({ message: child }))
			if (step.outMessage === undefined) return lifted
			const value = step.outMessage.value
			const organization = Option.getOrElse(AsyncData.getData(model.organizations.data), () => []).find((org) => org.id === value)
			const picked: Partial<DestinationForm> = {
				hazelOrganizationId: value,
				hazelOrganizationName: organization?.name ?? "",
				hazelOrganizationLogoUrl: organization?.logoUrl ?? null,
				hazelChannelId: "",
				hazelChannelName: "",
			}
			const loaded = reads(
				{ ...lifted.model, channelSelect: Select.init(CHANNEL_SELECT_ID, { value: "", selectedIndex: null }) },
				value.trim(),
				"Load",
			)
			return { ...withCommands(loaded, lifted.commands), form: picked }
		},
		GotChannelSelectMessage: ({ message: inner }) => {
			const step = Select.update(model.channelSelect, inner)
			const lifted = liftSelect(model, "channelSelect", step, (child) => Message.GotChannelSelectMessage({ message: child }))
			if (step.outMessage === undefined) return lifted
			const value = step.outMessage.value
			const channel = Option.getOrElse(AsyncData.getData(model.channels.data), () => []).find((candidate) => candidate.id === value)
			return { ...lifted, form: { hazelChannelId: value, hazelChannelName: channel?.name ?? form.hazelChannelName } }
		},
	})

/** The fields mount: the selects read the form, and the reads they need go out. */
export const reset = (model: Model, form: DestinationForm): Return =>
	reads(
		{
			...model,
			organizationSelect: Select.init(ORGANIZATION_SELECT_ID, { value: form.hazelOrganizationId, selectedIndex: null }),
			channelSelect: Select.init(CHANNEL_SELECT_ID, { value: form.hazelChannelId, selectedIndex: null }),
		},
		form.hazelOrganizationId.trim(),
		"Load",
	)

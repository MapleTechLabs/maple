import type { V2ChatConnectorList } from "@maple/domain/http/v2"
import { ChatConnectorId, ChatWorkspaceId } from "@maple/primitives"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type * as Keyed from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"

/** The chat module's own messages; the hub carries them in `GotChatMessage`. */
export const ChatMessage = defineMessageUnion({
	ClickedInstall: {},
	CompletedInstall: { failure: Schema.NullOr(LoadFailure) },
	ClickedIdentity: {},
	CompletedIdentity: { kind: Schema.Literals(["link", "unlink"]), failure: Schema.NullOr(LoadFailure) },
	ClickedDisconnect: { workspaceId: ChatWorkspaceId },
	CompletedDisconnect: { failure: Schema.NullOr(LoadFailure) },
})
export type ChatMessage = typeof ChatMessage.Type

/** The hub's status read for every chat connector at once. */
export const CHAT_STATUS_READ = {
	name: "LoadIntegrationsChatConnectors",
	read: (_refresh: boolean) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.chatIntegration.connectors()),
}

/** The connector's entry in the list, if it answered. */
export const connectorStatusOf = (
	status: Keyed.Keyed<V2ChatConnectorList, LoadFailure>,
	connector: ChatConnectorId | null,
) =>
	Option.getOrNull(
		Option.map(AsyncData.getData(status.data), (response) =>
			Option.getOrNull(Arr.findFirst(response.data, (entry) => entry.id === connector)),
		),
	)

/** Full-page redirect to the platform's consent screen, as the install and the account link do. */
const redirect = (url: string) => Effect.sync(() => window.location.assign(url))

const settled = <A, E, R, M>(
	effect: Effect.Effect<A, E, R>,
	done: (failure: ReturnType<typeof toLoadFailure> | null) => M,
) =>
	effect.pipe(
		Effect.match({
			onFailure: (error) => done(toLoadFailure(error)),
			onSuccess: () => done(null),
		}),
	)

/** `chatIntegration.install`; on success the browser leaves for the platform. */
export const InstallChat = Command.define("InstallChatConnector", {
	args: { connector: ChatConnectorId },
	messages: [ChatMessage.CompletedInstall],
	execute: ({ connector }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const response = yield* client.chatIntegration.install({ params: { connector } })
				yield* redirect(response.url)
			}),
			(failure) => ChatMessage.CompletedInstall({ failure }),
		),
})

export const LinkChatIdentity = Command.define("LinkChatIdentity", {
	args: { connector: ChatConnectorId },
	messages: [ChatMessage.CompletedIdentity],
	execute: ({ connector }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const response = yield* client.chatIntegration.startChatIdentityLink({
					params: { connector },
				})
				yield* redirect(response.url)
			}),
			(failure) => ChatMessage.CompletedIdentity({ kind: "link", failure }),
		),
})

export const UnlinkChatIdentity = Command.define("UnlinkChatIdentity", {
	args: { connector: ChatConnectorId },
	messages: [ChatMessage.CompletedIdentity],
	execute: ({ connector }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.chatIntegration.deleteChatIdentity({ params: { connector } })
			}),
			(failure) => ChatMessage.CompletedIdentity({ kind: "unlink", failure }),
		),
})

export const DisconnectChatWorkspace = Command.define("DisconnectChatWorkspace", {
	args: { id: ChatWorkspaceId },
	messages: [ChatMessage.CompletedDisconnect],
	execute: ({ id }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.chatIntegration.deleteWorkspace({ params: { id } })
			}),
			(failure) => ChatMessage.CompletedDisconnect({ failure }),
		),
})

export const ChatCardModel = Schema.Struct({
	/** One write at a time across the card: `"install"`, `"identity"` or a workspace id. */
	busy: Schema.NullOr(Schema.String),
	confirmId: Schema.NullOr(ChatWorkspaceId),
	/** The account link or unlink in flight (its own action, apart from `busy`). */
	identityBusy: Schema.Boolean,
})
export type ChatCardModel = typeof ChatCardModel.Type

export const initChatCard = (): ChatCardModel => ({ busy: null, confirmId: null, identityBusy: false })

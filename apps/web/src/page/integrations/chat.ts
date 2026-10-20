import { ChatConnectorId, ChatWorkspaceId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import { Message } from "./message"

// `ChatIntegrationCard`: its writes.

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
	messages: [Message.CompletedChatInstall],
	execute: ({ connector }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const response = yield* client.chatIntegration.install({ params: { connector } })
				yield* redirect(response.url)
			}),
			(failure) => Message.CompletedChatInstall({ failure }),
		),
})

export const LinkChatIdentity = Command.define("LinkChatIdentity", {
	args: { connector: ChatConnectorId },
	messages: [Message.CompletedChatIdentity],
	execute: ({ connector }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const response = yield* client.chatIntegration.startChatIdentityLink({
					params: { connector },
				})
				yield* redirect(response.url)
			}),
			(failure) => Message.CompletedChatIdentity({ kind: "link", failure }),
		),
})

export const UnlinkChatIdentity = Command.define("UnlinkChatIdentity", {
	args: { connector: ChatConnectorId },
	messages: [Message.CompletedChatIdentity],
	execute: ({ connector }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.chatIntegration.deleteChatIdentity({ params: { connector } })
			}),
			(failure) => Message.CompletedChatIdentity({ kind: "unlink", failure }),
		),
})

export const DisconnectChatWorkspace = Command.define("DisconnectChatWorkspace", {
	args: { id: ChatWorkspaceId },
	messages: [Message.CompletedChatDisconnect],
	execute: ({ id }) =>
		settled(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.chatIntegration.deleteWorkspace({ params: { id } })
			}),
			(failure) => Message.CompletedChatDisconnect({ failure }),
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

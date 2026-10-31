/**
 * Hazel gateway envelopes → Maple's normalized inbound events.
 *
 * Two envelopes produce one: a message starts (or continues) a turn, and a button press applies an
 * approval. Everything else the gateway delivers — edits, deletes, channel and member changes,
 * slash commands — is dropped here.
 */
import { Option, Schema } from "effect"
import type { InboundEvent } from "../../ingress.ts"
import { decodeInteractionCreate, decodeMessageCreate } from "./gateway-payloads.ts"
import { HAZEL_CONNECTOR_ID } from "./id.ts"

const decodeEventType = Schema.decodeUnknownOption(Schema.Struct({ eventType: Schema.String }))

/** `@[userId:<id>]`, Hazel's mention markup (`@hazel/domain`'s mention parser). */
export const mentionOf = (userId: string): string => `@[userId:${userId}]`

/** The bot's own mention removed. A literal split: the id comes off the wire. */
const stripMention = (text: string, botUserId: string): string =>
	text.split(mentionOf(botUserId)).join(" ").replace(/\s+/gu, " ").trim()

/** The workspace out of `org:<orgId>:channel:<channelId>`. */
const organizationOf = (partitionKey: string): string | undefined => {
	const [scope, organizationId] = partitionKey.split(":")
	return scope === "org" && organizationId !== undefined && organizationId !== ""
		? organizationId
		: undefined
}

/**
 * A message the bot can see, whether or not it was addressed to it.
 *
 * Hazel delivers every message in the workspace to an installed bot, its own included, so the
 * filters come first: its own messages, and any other bot's (two bots must not talk to each other).
 * A message with no text that does not mention the bot is not a turn either.
 */
// BOUNDARY: `envelope` is one undecoded event from a DISPATCH batch.
const messageCreate = (envelope: unknown, botUserId: string): ReadonlyArray<InboundEvent> => {
	const decoded = decodeMessageCreate(envelope)
	if (Option.isNone(decoded)) return []
	const { payload: message, author, partitionKey } = decoded.value
	const workspaceId = organizationOf(partitionKey)
	if (workspaceId === undefined) return []
	if (message.authorId === botUserId || author?.isBot === true) return []
	const mentionsBot = message.content.includes(mentionOf(botUserId))
	if (!mentionsBot && message.content.trim() === "") return []
	return [
		{
			type: "message",
			connector: HAZEL_CONNECTOR_ID,
			workspaceId,
			// A Hazel thread IS a channel with its own id, and a reply goes to that id — so
			// `channelId` already addresses it and `threadId` stays absent.
			channelId: message.channelId,
			messageId: message.id,
			author: {
				id: message.authorId,
				// Hazel names the author on every message event; one from a gateway that predates
				// that still reads as somebody.
				displayName: author?.displayName ?? "Someone",
				isBot: false,
			},
			text: stripMention(message.content, botUserId),
			mentionsBot,
		},
	]
}

/** A press on a button Maple rendered. The id is handed back verbatim; the host decodes it. */
// BOUNDARY: `envelope` is one undecoded event from a DISPATCH batch.
const interactionCreate = (envelope: unknown): ReadonlyArray<InboundEvent> => {
	const decoded = decodeInteractionCreate(envelope)
	if (Option.isNone(decoded)) return []
	const press = decoded.value.payload
	return [
		{
			type: "action",
			connector: HAZEL_CONNECTOR_ID,
			workspaceId: press.orgId,
			// The thread's own id when the button is in one, which is what names the conversation.
			channelId: press.channelId,
			messageId: press.messageId,
			actionToken: press.actionId,
			actor: { id: press.userId, displayName: press.userName },
		},
	]
}

/**
 * One batch's events. Without the bot's own user id — a gateway that predates READY naming it —
 * a mention cannot be told from any other message, so messages are dropped until it is known.
 */
export const mapEvents = (
	envelopes: ReadonlyArray<unknown>,
	botUserId: string | undefined,
): ReadonlyArray<InboundEvent> =>
	envelopes.flatMap((envelope) => {
		const type = Option.match(decodeEventType(envelope), {
			onNone: () => undefined,
			onSome: (decoded) => decoded.eventType,
		})
		if (type === "message.create")
			return botUserId === undefined ? [] : messageCreate(envelope, botUserId)
		if (type === "interaction.create") return interactionCreate(envelope)
		return []
	})

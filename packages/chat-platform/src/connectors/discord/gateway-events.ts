/**
 * Discord dispatch payloads → Maple's normalized inbound events.
 *
 * Only three dispatches produce one, because only three things happen
 * downstream: a mention starts a turn, a button click applies an approval, and
 * losing a guild unlinks a workspace. Everything else the intents deliver is
 * dropped here rather than carried further.
 */
import { Option } from "effect"
import type { ConnectorRequest, InboundEvent } from "../../ingress.ts"
import { API_BASE } from "./api.ts"
import {
	CALLBACK_DEFERRED_UPDATE_MESSAGE,
	decodeGuildDelete,
	decodeInteractionCreate,
	decodeMessageCreate,
	INTERACTION_MESSAGE_COMPONENT,
} from "./gateway-payloads.ts"
import { DISCORD_CONNECTOR_ID } from "./id.ts"

/** What one dispatch produced. Both lists are usually empty — most dispatches are noise. */
export interface DispatchResult {
	readonly events: ReadonlyArray<InboundEvent>
	readonly requests: ReadonlyArray<ConnectorRequest>
}

const NOTHING: DispatchResult = { events: [], requests: [] }

/**
 * Remove the bot's own mention from the text.
 *
 * Both forms, because Discord still emits the legacy nickname mention `<@!id>`
 * alongside `<@id>` for older clients. Literal splits rather than a constructed
 * `RegExp`: the id comes off the wire, and a pattern built from wire data is a
 * pattern somebody else chose.
 */
const stripMention = (text: string, botUserId: string): string =>
	text.split(`<@${botUserId}>`).join(" ").split(`<@!${botUserId}>`).join(" ").replace(/\s+/gu, " ").trim()

/**
 * Acknowledge a component click.
 *
 * Discord drops an interaction that is not answered within 3 seconds, and the
 * user sees it fail. A deferred UPDATE (callback type 6) is the acknowledgement
 * that changes nothing on screen, which is what a click whose real answer takes
 * an agent turn needs. The host issues it the moment the frame is handled; the
 * turn's actual reply arrives later over the outbound driver.
 *
 * Deliberately NOT the outbound half's request helper, and it carries no bot
 * token: an interaction callback is authenticated by the interaction token in
 * its own URL, and `onFrame` is a pure function that cannot reach an Effect
 * transport. The two halves share the base URL and nothing else here.
 */
const acknowledgeInteraction = (id: string, token: string): ConnectorRequest => ({
	method: "POST",
	url: `${API_BASE}/interactions/${id}/${encodeURIComponent(token)}/callback`,
	headers: new Map([["content-type", "application/json"]]),
	body: JSON.stringify({ type: CALLBACK_DEFERRED_UPDATE_MESSAGE }),
})

/**
 * A message the bot can see, whether or not it was addressed to it.
 *
 * Four filters, in the order that makes each one cheap. A message outside a
 * guild is not this connector's business (it asks for no DM intent, so this only
 * fires on payloads that arrive anyway). A bot or webhook author is dropped
 * before anything else so two Maple deployments in one server cannot talk to
 * each other. What is left is reported with `mentionsBot` set either way, and
 * the host decides whether a message that addressed nobody is still a turn.
 *
 * The last filter is for a message with no text of its own — an embed, an
 * attachment, a system notice, and every message at all if the application ever
 * loses its message-content grant. There is no turn to start from nothing, and
 * dropping those here is one fewer host round trip per message in every channel
 * the bot can see.
 */
// BOUNDARY: `data` is the decoded `d` of a gateway frame, typed at this edge.
const messageCreate = (data: unknown, botUserId: string | undefined): DispatchResult => {
	if (botUserId === undefined) return NOTHING
	const decoded = decodeMessageCreate(data)
	if (Option.isNone(decoded)) return NOTHING
	const message = decoded.value
	if (message.guild_id === undefined) return NOTHING
	if (message.author.bot === true || message.webhook_id !== undefined) return NOTHING
	const mentionsBot = message.mentions.some((user) => user.id === botUserId)
	if (!mentionsBot && message.content.trim() === "") return NOTHING
	return {
		events: [
			{
				type: "message",
				connector: DISCORD_CONNECTOR_ID,
				workspaceId: message.guild_id,
				// A Discord thread IS a channel with its own id, and a reply goes to
				// that id — so `channelId` already addresses it and `threadId` stays
				// absent. It is set by platforms that model a thread as a coordinate
				// within a channel.
				channelId: message.channel_id,
				messageId: message.id,
				author: {
					id: message.author.id,
					displayName:
						message.member?.nick ?? message.author.global_name ?? message.author.username,
					isBot: false,
				},
				text: stripMention(message.content, botUserId),
				mentionsBot,
			},
		],
		requests: [],
	}
}

/** A click on a control Maple rendered. */
// BOUNDARY: `data` is the decoded `d` of a gateway frame, typed at this edge.
const interactionCreate = (data: unknown): DispatchResult => {
	const decoded = decodeInteractionCreate(data)
	if (Option.isNone(decoded)) return NOTHING
	const interaction = decoded.value
	if (interaction.type !== INTERACTION_MESSAGE_COMPONENT) return NOTHING
	const { member, data: payload, message, guild_id, channel_id } = interaction
	// A component click outside a guild, or on a message this connector cannot
	// name, carries no workspace to authorize against — so it is not an action.
	if (
		member === undefined ||
		payload?.custom_id === undefined ||
		message === undefined ||
		guild_id === undefined ||
		channel_id === undefined
	) {
		return NOTHING
	}
	return {
		events: [
			{
				type: "action",
				connector: DISCORD_CONNECTOR_ID,
				workspaceId: guild_id,
				channelId: channel_id,
				messageId: message.id,
				actionToken: payload.custom_id,
				actor: {
					id: member.user.id,
					displayName: member.nick ?? member.user.global_name ?? member.user.username,
				},
			},
		],
		requests: [acknowledgeInteraction(interaction.id, interaction.token)],
	}
}

/** The bot left, or was removed from, a guild — as opposed to the guild being briefly unreachable. */
// BOUNDARY: `data` is the decoded `d` of a gateway frame, typed at this edge.
const guildDelete = (data: unknown): DispatchResult => {
	const decoded = decodeGuildDelete(data)
	if (Option.isNone(decoded) || decoded.value.unavailable === true) return NOTHING
	return {
		events: [
			{ type: "workspace-removed", connector: DISCORD_CONNECTOR_ID, workspaceId: decoded.value.id },
		],
		requests: [],
	}
}

/** Map one dispatch by name. `READY` is handled in the state machine, which is what it changes. */
// BOUNDARY: `data` is the decoded `d` of a gateway frame, typed at this edge.
export const mapDispatch = (name: string, data: unknown, botUserId: string | undefined): DispatchResult => {
	switch (name) {
		case "MESSAGE_CREATE":
			return messageCreate(data, botUserId)
		case "INTERACTION_CREATE":
			return interactionCreate(data)
		case "GUILD_DELETE":
			return guildDelete(data)
		default:
			return NOTHING
	}
}

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
import {
	ADMINISTRATOR,
	API_BASE_URL,
	CALLBACK_DEFERRED_UPDATE_MESSAGE,
	decodeGuildDelete,
	decodeInteractionCreate,
	decodeMessageCreate,
	INTERACTION_MESSAGE_COMPONENT,
	MANAGE_GUILD,
} from "./gateway-payloads.ts"
import { CONNECTOR_ID } from "./id.ts"

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
	text
		.split(`<@${botUserId}>`)
		.join(" ")
		.split(`<@!${botUserId}>`)
		.join(" ")
		.replace(/\s+/gu, " ")
		.trim()

/**
 * Whether the member may administer this workspace.
 *
 * `permissions` on an interaction is the member's EFFECTIVE permission set in
 * that channel, already resolved against roles and overwrites, so reading two
 * bits off it is the whole check. It is a decimal string wider than a JS number,
 * hence `BigInt` — and a value that is not decimal digits is treated as "no",
 * because a permission check that guesses should guess closed.
 */
const isWorkspaceAdmin = (permissions: string | undefined): boolean => {
	if (permissions === undefined || !/^\d+$/u.test(permissions)) return false
	const bits = BigInt(permissions)
	return (bits & MANAGE_GUILD) !== 0n || (bits & ADMINISTRATOR) !== 0n
}

/**
 * Acknowledge a component click.
 *
 * Discord drops an interaction that is not answered within 3 seconds, and the
 * user sees it fail. A deferred UPDATE (callback type 6) is the acknowledgement
 * that changes nothing on screen, which is what a click whose real answer takes
 * an agent turn needs. The host issues it the moment the frame is handled; the
 * turn's actual reply arrives later over the outbound driver.
 */
const acknowledgeInteraction = (id: string, token: string): ConnectorRequest => ({
	method: "POST",
	url: `${API_BASE_URL}/interactions/${id}/${encodeURIComponent(token)}/callback`,
	headers: new Map([["content-type", "application/json"]]),
	body: JSON.stringify({ type: CALLBACK_DEFERRED_UPDATE_MESSAGE }),
})

/**
 * A message addressed to the bot.
 *
 * Three filters, in the order that makes each one cheap. A message outside a
 * guild is not this connector's business (it asks for no DM intent, so this only
 * fires on payloads that arrive anyway). A bot or webhook author is dropped
 * before anything else so two Maple deployments in one server cannot talk to
 * each other. And without a mention there is nothing to answer — with no
 * `MESSAGE_CONTENT` intent, `content` would be empty for those anyway.
 */
// BOUNDARY: `data` is the decoded `d` of a gateway frame, typed at this edge.
const messageCreate = (data: unknown, botUserId: string | undefined): DispatchResult => {
	if (botUserId === undefined) return NOTHING
	const decoded = decodeMessageCreate(data)
	if (Option.isNone(decoded)) return NOTHING
	const message = decoded.value
	if (message.guild_id === undefined) return NOTHING
	if (message.author.bot === true || message.webhook_id !== undefined) return NOTHING
	if (!message.mentions.some((user) => user.id === botUserId)) return NOTHING
	return {
		events: [
			{
				type: "message",
				connector: CONNECTOR_ID,
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
						message.member?.nick ??
						message.author.global_name ??
						message.author.username,
					isBot: false,
				},
				text: stripMention(message.content, botUserId),
				mentionsBot: true,
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
				connector: CONNECTOR_ID,
				workspaceId: guild_id,
				channelId: channel_id,
				messageId: message.id,
				actionToken: payload.custom_id,
				actor: {
					id: member.user.id,
					displayName: member.nick ?? member.user.global_name ?? member.user.username,
					roleIds: member.roles,
					isWorkspaceAdmin: isWorkspaceAdmin(member.permissions),
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
		events: [{ type: "workspace-removed", connector: CONNECTOR_ID, workspaceId: decoded.value.id }],
		requests: [],
	}
}

/** Map one dispatch by name. `READY` is handled in the state machine, which is what it changes. */
// BOUNDARY: `data` is the decoded `d` of a gateway frame, typed at this edge.
export const mapDispatch = (
	name: string,
	data: unknown,
	botUserId: string | undefined,
): DispatchResult => {
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

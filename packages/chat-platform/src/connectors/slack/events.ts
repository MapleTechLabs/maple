/**
 * Slack payloads → Maple's normalized inbound events.
 *
 * Four kinds produce one, because four things happen downstream: a mention starts a turn, a reply
 * in a thread continues it, a button click applies an approval, and an uninstall unlinks a
 * workspace. Everything else Slack delivers is dropped here rather than carried further.
 */
import { Option } from "effect"
import type { InboundEvent } from "../../ingress"
import { SLACK_CONNECTOR_ID } from "./id"
import { botUserIdOf, type SlackBlockActions, type SlackEventCallback, type SlackEventBody } from "./payloads"

/** Events that unlink the workspace. Both identify it by the envelope's `team_id` and nothing else. */
const REMOVAL_EVENTS: ReadonlySet<string> = new Set(["app_uninstalled", "tokens_revoked"])

/**
 * Remove the bot's own mention from the text.
 *
 * Slack writes a mention as `<@U0123>`, occasionally with a display label (`<@U0123|maple>`), so
 * both forms are cut. Literal splits rather than a constructed `RegExp`: the id comes off the
 * wire, and a pattern built from wire data is a pattern somebody else chose.
 */
export const stripMention = (text: string, botUserId: string): string => {
	const parts = text.split(`<@${botUserId}>`).join(" ").split(`<@${botUserId}|`)
	return parts
		.map((part, index) => (index === 0 ? part : part.slice(part.indexOf(">") + 1)))
		.join(" ")
		.replace(/\s+/gu, " ")
		.trim()
}

/** Whether the text addresses the bot, in either mention form. */
const mentionsBot = (text: string, botUserId: string): boolean =>
	text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`)

/**
 * A message this connector could answer at all.
 *
 * Bot-authored messages are dropped before anything else — the bot's own answers come back as
 * events, and two Maple deployments in one workspace must not talk to each other. A `subtype` is
 * every other thing Slack calls a message: an edit, a deletion, a join notice, a file share. None
 * of them is somebody asking a question, and several carry no author at all.
 */
const isAnswerable = (
	event: SlackEventBody,
): event is SlackEventBody & { channel: string; user: string; ts: string; text: string } =>
	event.bot_id === undefined &&
	event.subtype === undefined &&
	event.channel !== undefined &&
	event.user !== undefined &&
	event.ts !== undefined &&
	event.text !== undefined

/**
 * The conversation a reply belongs to: the thread if there is one, otherwise the message itself.
 *
 * A top-level mention's own `ts` becomes the thread — answering it in a thread is what keeps a
 * channel readable — and `outbound.ts` addresses replies with the same value.
 */
const threadOf = (event: { readonly ts: string; readonly thread_ts?: string }): string =>
	event.thread_ts ?? event.ts

/**
 * What an `event_callback` means to Maple, as zero or one normalized events.
 *
 * `app_mention` and `message` overlap: a mention inside a subscribed channel arrives as BOTH, and
 * delivering it twice would start a turn and then feed the same question into it. So `message` is
 * read only for replies inside a thread, and a reply that mentions the bot is left to the
 * `app_mention` delivery that carries it.
 */
export const eventCallbackToInbound = (callback: SlackEventCallback): ReadonlyArray<InboundEvent> => {
	const event = callback.event
	if (REMOVAL_EVENTS.has(event.type)) {
		return [{ type: "workspace-removed", connector: SLACK_CONNECTOR_ID, workspaceId: callback.team_id }]
	}
	if (event.type !== "app_mention" && !event.type.startsWith("message")) return []
	if (!isAnswerable(event)) return []

	const botUserId = botUserIdOf(callback)
	if (event.type === "app_mention") {
		return [
			{
				type: "message",
				connector: SLACK_CONNECTOR_ID,
				workspaceId: callback.team_id,
				channelId: event.channel,
				// Slack models a thread as a coordinate inside a channel rather than as a channel of
				// its own, so both are carried and a reply needs both to land in the right place.
				threadId: threadOf(event),
				messageId: event.ts,
				author: { id: event.user, displayName: event.user, isBot: false },
				text: Option.match(botUserId, {
					onNone: () => event.text,
					onSome: (id) => stripMention(event.text, id),
				}),
				mentionsBot: true,
			},
		]
	}

	// A `message` outside a thread is channel conversation the bot was not addressed in; there is
	// no follow-up for it to continue.
	if (event.thread_ts === undefined) return []
	// Already delivered as `app_mention`. Checked against the bot id when Slack named one, and
	// otherwise not at all: dropping a follow-up on the guess that some mention was ours would lose
	// a message, where delivering one Slack also sent as a mention is a duplicate the host drops.
	if (Option.isSome(botUserId) && mentionsBot(event.text, botUserId.value)) return []
	return [
		{
			type: "message",
			connector: SLACK_CONNECTOR_ID,
			workspaceId: callback.team_id,
			channelId: event.channel,
			threadId: event.thread_ts,
			messageId: event.ts,
			author: { id: event.user, displayName: event.user, isBot: false },
			text: event.text,
			mentionsBot: false,
		},
	]
}

/**
 * A button press → an `action`, if it carries one of Maple's tokens.
 *
 * `actor` reports what Slack sends, which is an id and a name — all the contract asks for. Whether
 * that person may approve is decided by whether they linked the account to a Maple user, and this
 * connector declares no `identity`, so nobody can: see the README for why, and for what the link
 * would cost.
 */
export const blockActionsToInbound = (payload: SlackBlockActions): ReadonlyArray<InboundEvent> => {
	// The workspace is the TEAM the interaction happened in, never `user.team_id`: in a Slack
	// Connect shared channel the clicker can belong to another workspace entirely, and resolving
	// by their team would answer in one org's name for another org's conversation.
	const workspaceId = payload.team?.id
	const channelId = payload.channel?.id ?? payload.container?.channel_id
	const messageId = payload.container?.message_ts ?? payload.message?.ts
	const actionToken = payload.actions.find((action) => action.value !== undefined)?.value
	if (workspaceId === undefined || channelId === undefined || messageId === undefined) return []
	if (actionToken === undefined) return []
	// The control sits on Maple's own answer, which lives in the thread the question opened — so
	// the answer's `thread_ts` is that thread, and naming the conversation by it is what puts the
	// click on the same session as the proposal. A control somehow outside a thread falls back to
	// its own message, which is what a top-level conversation would have been keyed by anyway.
	const threadId = payload.message?.thread_ts ?? messageId
	return [
		{
			type: "action",
			connector: SLACK_CONNECTOR_ID,
			workspaceId,
			channelId,
			threadId,
			messageId,
			actionToken,
			// An id and a name, which is all Slack sends. Whether this person may approve is not a
			// fact Slack holds — it is whether they linked this account to a Maple user.
			actor: {
				id: payload.user.id,
				displayName: payload.user.name ?? payload.user.username ?? payload.user.id,
			},
		},
	]
}

/**
 * Slack payloads → normalized events, from payloads shaped like the ones its documentation prints.
 *
 * The fixtures are deliberately whole envelopes rather than the fields the mapping happens to
 * read: a decode that started requiring one more key would pass a hand-trimmed fixture and fail a
 * real delivery.
 */
import { describe, expect, it } from "vitest"
import { blockActionsToInbound, eventCallbackToInbound, stripMention } from "./events"
import { decodeBlockActions, decodeEventRequest } from "./payloads"
import { Option } from "effect"

const BOT = "U0LAN0Z89"

const envelope = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	token: "z26uFbvR1xHJEdHE1OQiO6t8",
	team_id: "T061EG9R6",
	api_app_id: "A0MDYCDME",
	event,
	type: "event_callback",
	event_id: "Ev0MDYGDKJ",
	event_time: 1_515_449_522,
	authorizations: [
		{
			enterprise_id: null,
			team_id: "T061EG9R6",
			user_id: BOT,
			is_bot: true,
			is_enterprise_install: false,
		},
	],
	is_ext_shared_channel: false,
	event_context: "EC12345",
	...extra,
})

const mapped = (payload: Record<string, unknown>) => {
	const decoded = decodeEventRequest(JSON.stringify(payload))
	if (Option.isNone(decoded)) throw new Error("the fixture did not decode")
	const request = decoded.value
	if (request.type !== "event_callback") throw new Error("the fixture is not an event callback")
	return eventCallbackToInbound(request)
}

describe("slack mentions", () => {
	it("turns an app_mention into a turn without the bot's own name in it", () => {
		const events = mapped(
			envelope({
				type: "app_mention",
				user: "U061F7AUR",
				text: `<@${BOT}> why is checkout slow?`,
				ts: "1515449522.000016",
				channel: "C0LAN2Q65",
				event_ts: "1515449522000016",
			}),
		)
		expect(events).toEqual([
			{
				type: "message",
				connector: "slack",
				workspaceId: "T061EG9R6",
				channelId: "C0LAN2Q65",
				// A top-level mention's own `ts` is the thread the answer goes in.
				threadId: "1515449522.000016",
				messageId: "1515449522.000016",
				author: { id: "U061F7AUR", displayName: "U061F7AUR", isBot: false },
				text: "why is checkout slow?",
				mentionsBot: true,
			},
		])
	})

	it("keeps the thread a mention was already in", () => {
		const events = mapped(
			envelope({
				type: "app_mention",
				user: "U061F7AUR",
				text: `<@${BOT}> and the p99?`,
				ts: "1515449600.000100",
				thread_ts: "1515449522.000016",
				channel: "C0LAN2Q65",
				event_ts: "1515449600000100",
			}),
		)
		expect(events[0]).toMatchObject({ threadId: "1515449522.000016", messageId: "1515449600.000100" })
	})

	it("reads a mention it cannot attribute to a bot user verbatim", () => {
		// No `authorizations`: the text is still the question, just with the mention left in it.
		const { authorizations: _dropped, ...unattributed } = envelope({
			type: "app_mention",
			user: "U061F7AUR",
			text: `<@${BOT}> hello`,
			ts: "1515449522.000016",
			channel: "C0LAN2Q65",
		})
		const events = mapped(unattributed)
		expect(events[0]).toMatchObject({ text: `<@${BOT}> hello`, mentionsBot: true })
	})
})

describe("slack thread replies", () => {
	const reply = (event: Record<string, unknown>) =>
		mapped(
			envelope({
				type: "message",
				channel: "C0LAN2Q65",
				user: "U061F7AUR",
				text: "and the p99?",
				ts: "1515449600.000100",
				thread_ts: "1515449522.000016",
				channel_type: "channel",
				...event,
			}),
		)

	it("carries a reply inside a thread as an un-addressed follow-up", () => {
		expect(reply({})).toEqual([
			{
				type: "message",
				connector: "slack",
				workspaceId: "T061EG9R6",
				channelId: "C0LAN2Q65",
				threadId: "1515449522.000016",
				messageId: "1515449600.000100",
				author: { id: "U061F7AUR", displayName: "U061F7AUR", isBot: false },
				text: "and the p99?",
				mentionsBot: false,
			},
		])
	})

	it("ignores channel conversation that is not in a thread", () => {
		const { thread_ts: _dropped, ...top } = {
			type: "message",
			channel: "C0LAN2Q65",
			user: "U061F7AUR",
			text: "unrelated chatter",
			ts: "1515449600.000100",
			thread_ts: "1515449522.000016",
			channel_type: "channel",
		}
		expect(mapped(envelope(top))).toEqual([])
	})

	it("ignores a reply that mentions the bot, which arrives as an app_mention too", () => {
		expect(reply({ text: `<@${BOT}> and the p99?` })).toEqual([])
	})

	it("ignores the bot's own answers and every message subtype", () => {
		expect(reply({ bot_id: "B0MDYCDME" })).toEqual([])
		expect(reply({ subtype: "message_changed" })).toEqual([])
		expect(reply({ subtype: "channel_join" })).toEqual([])
	})
})

describe("slack workspace removal", () => {
	it("unlinks on an uninstall, naming the workspace from the envelope", () => {
		expect(mapped(envelope({ type: "app_uninstalled" }))).toEqual([
			{ type: "workspace-removed", connector: "slack", workspaceId: "T061EG9R6" },
		])
	})

	it("unlinks on revoked tokens too", () => {
		expect(mapped(envelope({ type: "tokens_revoked", tokens: { bot: [BOT], oauth: [] } }))).toEqual([
			{ type: "workspace-removed", connector: "slack", workspaceId: "T061EG9R6" },
		])
	})
})

describe("slack url verification", () => {
	it("decodes the handshake as its own kind of request", () => {
		const decoded = decodeEventRequest(
			JSON.stringify({
				token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
				challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
				type: "url_verification",
			}),
		)
		expect(Option.isSome(decoded) && decoded.value.type).toBe("url_verification")
	})
})

describe("slack button presses", () => {
	const payload = (overrides: Record<string, unknown> = {}) => ({
		type: "block_actions",
		team: { id: "T061EG9R6", domain: "maple" },
		user: { id: "U061F7AUR", username: "ada", name: "ada", team_id: "T061EG9R6" },
		api_app_id: "A0MDYCDME",
		token: "9s8d9as89d8as9d8as989",
		container: { type: "message", message_ts: "1515449522.000016", channel_id: "C0LAN2Q65" },
		trigger_id: "12321423423.333649436676.d8c1bb837935619ccad0f624c448ffb3",
		channel: { id: "C0LAN2Q65", name: "incidents" },
		response_url: "https://hooks.slack.com/actions/T061EG9R6/1234/abcd",
		actions: [
			{
				action_id: "maple_approve",
				block_id: "b1",
				text: { type: "plain_text", text: "Run create_dashboard" },
				value: "sess-1|call-1",
				type: "button",
				action_ts: "1515449530.000000",
			},
		],
		...overrides,
	})

	const mapAction = (raw: Record<string, unknown>) => {
		const decoded = decodeBlockActions(JSON.stringify(raw))
		if (Option.isNone(decoded)) throw new Error("the fixture did not decode")
		return blockActionsToInbound(decoded.value)
	}

	it("round-trips the token the button carried, with an actor Slack told us nothing about", () => {
		expect(mapAction(payload())).toEqual([
			{
				type: "action",
				connector: "slack",
				workspaceId: "T061EG9R6",
				channelId: "C0LAN2Q65",
				messageId: "1515449522.000016",
				actionToken: "sess-1|call-1",
				// Slack's interaction payload carries no roles and no admin flag. Reporting none is
				// the honest answer; guessing `true` here would be an authorization decision made by
				// the absence of data.
				actor: { id: "U061F7AUR", displayName: "ada", roleIds: [], isWorkspaceAdmin: false },
			},
		])
	})

	it("ignores a press that carries no value — nothing Maple rendered looks like that", () => {
		expect(mapAction(payload({ actions: [{ action_id: "someone_elses", block_id: "b1" }] }))).toEqual([])
	})

	it("falls back to the container when the payload names no channel of its own", () => {
		const { channel: _dropped, ...withoutChannel } = payload()
		expect(mapAction(withoutChannel)[0]).toMatchObject({ channelId: "C0LAN2Q65" })
	})
})

describe("stripping the bot's mention", () => {
	it("removes both of Slack's mention forms and tidies the spacing", () => {
		expect(stripMention(`<@${BOT}>   why is  checkout slow?`, BOT)).toBe("why is checkout slow?")
		expect(stripMention(`hey <@${BOT}|maple> look`, BOT)).toBe("hey look")
	})

	it("leaves everybody else's mentions alone", () => {
		expect(stripMention(`<@${BOT}> ask <@U9999> about it`, BOT)).toBe("ask <@U9999> about it")
	})
})

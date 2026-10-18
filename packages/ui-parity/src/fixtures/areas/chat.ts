import { parseWarehouseDateTime } from "@maple/query-engine"
import type { FixtureArea, RawRoute } from "../areas.ts"
import type { Dataset } from "../dataset.ts"
import { defaultDataset } from "../datasets/default.ts"
import { MINUTE } from "../identity.ts"

/**
 * `/chat`'s durable transcript (`GET /api/chat/sessions/<orgId>:<tab>/history`, a raw route in
 * apps/ai). `chat-conversation` is the Acme org (same warehouse seed) with one finished
 * investigation of the payment-svc incident; every other dataset has an empty conversation.
 */

export const CHAT_CONVERSATION_DATASET = "chat-conversation"

const HISTORY_PATH = /^\/api\/chat\/sessions\/[^/]+\/history$/

const conversation = (nowMs: number) => {
	const at = (minutesAgo: number) => nowMs - minutesAgo * MINUTE
	const question = "Why is checkout slow since the payment-svc 3.5.0 rollout?"
	const answer = [
		"payment-svc 3.5.0 is exhausting its Postgres connection pool.",
		"",
		"- **p95 latency** on `POST /payments/authorize` went from 180 ms to 1.8 s right after the rollout.",
		"- **Errors**: 312 `PoolTimeoutError: timed out acquiring a connection` in the last hour, all on 3.5.0 pods.",
		"- **Cause**: 3.5.0 lowered `pool.max` from 20 to 5 while adding a second query per authorization.",
		"",
		"Rolling back to 3.4.2 or restoring `pool.max: 20` should clear it. The open alert *Payment p95 latency* will resolve once p95 drops under 800 ms.",
	].join("\n")
	return [
		{
			id: "msg_parity_user_1",
			role: "user",
			text: question,
			toolCalls: [],
			createdAt: at(12),
			startSeq: 1,
		},
		{
			id: "msg_parity_assistant_1",
			role: "assistant",
			text: answer,
			toolCalls: [
				{
					id: "call_parity_1",
					name: "service_overview",
					label: "Checking payment-svc health",
					input: { service: "payment-svc", time_window: "3h" },
					output: { service: "payment-svc", p95Ms: 1840, errorRate: 0.042, throughputPerMin: 96 },
					textOffset: 0,
				},
				{
					id: "call_parity_2",
					name: "find_errors",
					label: "Looking for new errors",
					input: { service: "payment-svc", time_window: "1h" },
					output: { issues: [{ type: "PoolTimeoutError", count: 312, firstSeen: "3.5.0" }] },
					textOffset: 0,
				},
				{
					id: "call_parity_3",
					name: "list_releases",
					input: { service: "payment-svc" },
					output: {
						releases: [{ version: "3.5.0", deployedMinutesAgo: 110 }, { version: "3.4.2" }],
					},
					textOffset: 62,
				},
			],
			createdAt: at(11),
			startSeq: 2,
		},
	]
}

const history: RawRoute = {
	tag: "chat.history",
	answer: ({ dataset, url, method }) => {
		if (method !== "GET" || !HISTORY_PATH.test(url.pathname)) return undefined
		const messages =
			dataset.name === CHAT_CONVERSATION_DATASET
				? conversation(parseWarehouseDateTime(dataset.now))
				: []
		return Response.json({ messages, cursor: messages.length === 0 ? 0 : 40, running: false })
	},
}

const MESSAGES_PATH = /^\/api\/chat\/sessions\/[^/]+\/messages$/
const EVENTS_PATH = /^\/api\/chat\/sessions\/[^/]+\/events$/
const ABORT_PATH = /^\/api\/chat\/sessions\/[^/]+\/abort$/

/** The cursor a send answers with: the end of the dataset's history. */
const historyCursor = (dataset: Dataset) => (dataset.name === CHAT_CONVERSATION_DATASET ? 40 : 0)

/** `POST .../messages`: accepted, the submission's id, the cursor just before its first event. */
const send: RawRoute = {
	tag: "chat.send",
	answer: ({ dataset, url, method }) =>
		method === "POST" && MESSAGES_PATH.test(url.pathname)
			? Response.json({ cursor: historyCursor(dataset), messageId: "msg_parity_user_sent" })
			: undefined,
}

/** The scripted reply to any send: a tool call that settles, then the answer streamed in deltas. */
const scriptedTurn = (cursor: number) => {
	const messageId = "msg_parity_assistant_sent"
	const answer = [
		"checkout-api is **healthy**: p95 is 210 ms and the error rate is 0.2% over the last hour.",
		"",
		"- `POST /checkout` is the slowest operation at 480 ms.",
		"- No new error fingerprints since the 3.4.2 deploy.",
	].join("\n")
	const deltas = answer.match(/[^\n]+\n*|\n+/g) ?? [answer]
	const events = [
		{ type: "user-message", id: "msg_parity_user_sent", text: "" },
		{ type: "turn-start", messageId },
		{
			type: "tool-call",
			messageId,
			callId: "call_parity_sent_1",
			name: "service_overview",
			input: { service: "checkout-api", time_window: "1h" },
		},
		{
			type: "tool-result",
			messageId,
			callId: "call_parity_sent_1",
			output: { service: "checkout-api", p95Ms: 210, errorRate: 0.002 },
		},
		...deltas.map((text) => ({ type: "text-delta", messageId, text })),
		{ type: "turn-end", messageId, reason: "stop" },
	]
	return events.map((event, index) => ({ ...event, seq: cursor + index + 1 }))
}

/** `GET .../events?cursor=`: the scripted turn as SSE frames, ending with its `turn-end`. */
const events: RawRoute = {
	tag: "chat.events",
	answer: ({ url, method }) => {
		if (method !== "GET" || !EVENTS_PATH.test(url.pathname)) return undefined
		const cursor = Number(url.searchParams.get("cursor") ?? "0")
		const frames = scriptedTurn(cursor)
			.map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
			.join("")
		return new Response(frames, { headers: { "content-type": "text/event-stream" } })
	},
}

const abort: RawRoute = {
	tag: "chat.abort",
	answer: ({ url, method }) =>
		method === "POST" && ABORT_PATH.test(url.pathname) ? new Response(null, { status: 204 }) : undefined,
}

const chatConversationDataset: Dataset = { ...defaultDataset, name: CHAT_CONVERSATION_DATASET }

export const fixtureArea: FixtureArea = {
	area: "chat",
	rawRoutes: [history, send, events, abort],
	datasets: [chatConversationDataset],
}

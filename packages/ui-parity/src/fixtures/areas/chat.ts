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
		{ id: "msg_parity_user_1", role: "user", text: question, toolCalls: [], createdAt: at(12), startSeq: 1 },
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
					output: { releases: [{ version: "3.5.0", deployedMinutesAgo: 110 }, { version: "3.4.2" }] },
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
		const messages = dataset.name === CHAT_CONVERSATION_DATASET ? conversation(parseWarehouseDateTime(dataset.now)) : []
		return Response.json({ messages, cursor: messages.length === 0 ? 0 : 40, running: false })
	},
}

const chatConversationDataset: Dataset = { ...defaultDataset, name: CHAT_CONVERSATION_DATASET }

export const fixtureArea: FixtureArea = {
	area: "chat",
	rawRoutes: [history],
	datasets: [chatConversationDataset],
}

/**
 * The driver, against a connector that is nobody's platform.
 *
 * `testchat` exists so these tests cannot accidentally encode one vendor's behaviour: it records
 * what it was asked to post and edit, and nothing else. Timing is `TestClock`, so throttling is
 * asserted rather than waited for.
 */
import { describe, expect, it } from "@effect/vitest"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	makeChatSessionId,
	type ChatEvent,
	type ChatEventInput,
} from "@maple/domain/chat-session"
import { Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { chatConnectorId } from "./connector"
import { driveChatTurn } from "./driver"
import type { ChatMessageRef, ChatOutbound, ChatTarget } from "./outbound"
import type { ChatBlock, ChatRenderContext } from "./render"

const sessionId = makeChatSessionId("org_1", "bot-42")

const context: ChatRenderContext = {
	appBaseUrl: "https://app.maple.dev",
	sessionId,
	chartImageUrl: () => null,
}

const target: ChatTarget = { conversationId: "conv_1" }

const EDIT_INTERVAL = Duration.seconds(1)

/** Nobody's platform: the driver must not be testable only against a real vendor's behaviour. */
const TESTCHAT = chatConnectorId("testchat")

interface Recorder {
	readonly outbound: ChatOutbound
	/** Every post and edit, in order, as `<verb> <messageId>` plus the blocks it carried. */
	readonly calls: Array<{ verb: "post" | "edit"; ref: ChatMessageRef; blocks: ReadonlyArray<ChatBlock> }>
	readonly typing: Array<string>
}

const recorder = (maxMessageChars = 500): Recorder => {
	const calls: Recorder["calls"] = []
	const typing: Array<string> = []
	let posted = 0
	return {
		calls,
		typing,
		outbound: {
			connectorId: TESTCHAT,
			limits: { maxMessageChars, minEditInterval: EDIT_INTERVAL },
			transport: Effect.sync(() => ({
				post: (postTarget, blocks) =>
					Effect.sync(() => {
						const ref = { conversationId: postTarget.conversationId, messageId: `m${++posted}` }
						calls.push({ verb: "post", ref, blocks })
						return ref
					}),
				edit: (ref, blocks) => Effect.sync(() => void calls.push({ verb: "edit", ref, blocks })),
				typing: (typingTarget) => Effect.sync(() => void typing.push(typingTarget.conversationId)),
			})),
		},
	}
}

/** Through the real codec, so the driver folds exactly what the wire would hand it. */
const event = (seq: number, input: ChatEventInput): ChatEvent =>
	decodeChatEventPayload(encodeChatEventPayload(input), seq)

/** A stream that makes the clock wait `delay` before each event, so throttling is observable. */
const timeline = (steps: ReadonlyArray<readonly [Duration.Duration, ChatEvent]>) =>
	Stream.fromIterable(steps).pipe(Stream.mapEffect(([delay, next]) => Effect.as(Effect.sleep(delay), next)))

const NOW = Duration.zero

const prose = (blocks: ReadonlyArray<ChatBlock>): string =>
	blocks
		.filter((block) => block.kind === "prose")
		.map((block) => block.markdown)
		.join("\n")

describe("driveChatTurn", () => {
	it.effect("posts a placeholder, coalesces deltas into throttled edits, and flushes at the end", () =>
		Effect.gen(function* () {
			const chat = recorder()
			const fiber = yield* Effect.forkChild(
				driveChatTurn({
					events: timeline([
						[NOW, event(1, { type: "turn-start", messageId: "a1" })],
						[NOW, event(2, { type: "text-delta", messageId: "a1", text: "Check" })],
						[NOW, event(3, { type: "text-delta", messageId: "a1", text: "ing" })],
						// Past the edit interval, so the throttle fiber gets a turn before this lands.
						[
							Duration.millis(1500),
							event(4, { type: "text-delta", messageId: "a1", text: " it." }),
						],
						[NOW, event(5, { type: "turn-end", messageId: "a1", reason: "stop" })],
					]),
					outbound: chat.outbound,
					target,
					context,
				}),
			)

			yield* TestClock.adjust("2 seconds")
			yield* Fiber.join(fiber)

			expect(chat.calls.map((call) => call.verb)).toEqual(["post", "edit", "edit"])
			// The placeholder says the bot is working before a single token has landed.
			expect(chat.calls[0].blocks).toEqual([
				{ kind: "notice", tone: "pending", text: "Working on it…" },
			])
			// Two deltas, one edit: the throttle coalesces rather than editing per token.
			expect(prose(chat.calls[1].blocks)).toBe("Checking")
			expect(prose(chat.calls[2].blocks)).toBe("Checking it.")
			expect(chat.typing).toEqual(["conv_1"])
		}),
	)

	it.effect("re-renders a retracted attempt instead of leaving the text it took back", () =>
		Effect.gen(function* () {
			const chat = recorder()
			yield* driveChatTurn({
				events: timeline([
					[NOW, event(1, { type: "turn-start", messageId: "a1" })],
					[NOW, event(2, { type: "text-delta", messageId: "a1", text: "Half an ans" })],
					[
						NOW,
						event(3, {
							type: "turn-retry",
							messageId: "a1",
							attempt: 2,
							retractChars: 11,
							reason: "overloaded",
							delayMs: 0,
						}),
					],
					[NOW, event(4, { type: "text-delta", messageId: "a1", text: "The answer." })],
					[NOW, event(5, { type: "turn-end", messageId: "a1", reason: "stop" })],
				]),
				outbound: chat.outbound,
				target,
				context,
			})

			expect(prose(chat.calls[chat.calls.length - 1].blocks)).toBe("The answer.")
		}),
	)

	it.effect("continues a turn that outgrows one message in a follow-up message", () =>
		Effect.gen(function* () {
			const chat = recorder(80)
			yield* driveChatTurn({
				events: timeline([
					[NOW, event(1, { type: "turn-start", messageId: "a1" })],
					[NOW, event(2, { type: "text-delta", messageId: "a1", text: "line\n".repeat(30) })],
					[NOW, event(3, { type: "turn-end", messageId: "a1", reason: "stop" })],
				]),
				outbound: chat.outbound,
				target,
				context,
			})

			const posts = chat.calls.filter((call) => call.verb === "post")
			expect(posts.length).toBeGreaterThan(1)
			// Every message the follow-ups carry is within the budget the connector declared.
			for (const call of chat.calls) expect(prose(call.blocks).length).toBeLessThanOrEqual(80)
		}),
	)

	it.effect("ends a proposed mutation as an approval, and a failed turn as a notice", () =>
		Effect.gen(function* () {
			const chat = recorder()
			yield* driveChatTurn({
				events: timeline([
					[NOW, event(1, { type: "turn-start", messageId: "a1" })],
					[
						NOW,
						event(2, {
							type: "tool-call",
							messageId: "a1",
							callId: "call_9",
							name: "create_alert_rule",
							input: { name: "checkout p95" },
							proposed: true,
						}),
					],
					[
						NOW,
						event(3, {
							type: "turn-end",
							messageId: "a1",
							reason: "error",
							error: "upstream said no",
						}),
					],
				]),
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls[chat.calls.length - 1].blocks).toEqual([
				{
					kind: "approval",
					toolName: "create_alert_rule",
					summary: "name: checkout p95",
					token: "org_1:bot-42|call_9",
				},
				{ kind: "notice", tone: "error", text: "Failed: upstream said no" },
			])
		}),
	)

	it.effect("still says something when a turn fails before it ever started", () =>
		Effect.gen(function* () {
			const chat = recorder()
			// The engine emits `turn-start` from the run itself, so a turn that dies while it is being
			// built — a layer, a model, a credential — reaches the session as a `turn-end` alone.
			yield* driveChatTurn({
				events: timeline([
					[
						NOW,
						event(1, { type: "turn-end", messageId: "a1", reason: "error", error: "no model" }),
					],
				]),
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls).toHaveLength(1)
			expect(chat.calls[0].blocks).toEqual([
				{ kind: "notice", tone: "error", text: "Failed: no model" },
			])
		}),
	)

	it.effect("takes a reconnect's replay as the same turn, not a second one", () =>
		Effect.gen(function* () {
			const chat = recorder()
			const start = event(1, { type: "turn-start", messageId: "a1" })
			const first = event(2, { type: "text-delta", messageId: "a1", text: "Check" })
			yield* driveChatTurn({
				events: timeline([
					[NOW, start],
					[NOW, first],
					// `subscribe(cursor)` resends from a cursor that may predate what was already folded.
					[NOW, start],
					[NOW, first],
					[NOW, event(3, { type: "text-delta", messageId: "a1", text: "ing." })],
					[NOW, event(4, { type: "turn-end", messageId: "a1", reason: "stop" })],
				]),
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls.filter((call) => call.verb === "post")).toHaveLength(1)
			expect(prose(chat.calls[chat.calls.length - 1].blocks)).toBe("Checking.")
		}),
	)
})

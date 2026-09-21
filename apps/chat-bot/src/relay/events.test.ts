/**
 * The session's frames, as this Worker reads them.
 *
 * Separate from the relay's own test because the failure modes here are the transport's: a payload
 * split across two chunks, a frame carrying something this build does not understand, and a
 * session that cannot be subscribed to at all.
 */
import { describe, expect, it } from "@effect/vitest"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEvent,
	type ChatEventInput,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { Effect, Stream } from "effect"
import { chatTurnEvents, ChatSessionUnreachable } from "./events.ts"

const event = (seq: number, input: ChatEventInput): ChatEvent =>
	decodeChatEventPayload(encodeChatEventPayload(input), seq)

/** Bytes in two chunks, cut mid-frame, so the decoder's buffer is exercised rather than assumed. */
const frames = (payload: string): ReadableStream<Uint8Array> => {
	const bytes = new TextEncoder().encode(payload)
	const cut = Math.floor(bytes.length / 2)
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, cut))
			controller.enqueue(bytes.slice(cut))
			controller.close()
		},
	})
}

/** What the session writes: one frame per event, behind the `retry:` hint it opens with. */
const sse = (events: ReadonlyArray<ChatEvent>): ReadableStream<Uint8Array> =>
	frames(
		"retry: 1000\n\n" +
			events.map((next) => `id: ${next.seq}\ndata: ${JSON.stringify(next)}\n\n`).join(""),
	)

const stub = (connections: ReadonlyArray<ReadonlyArray<ChatEvent>>): ChatSessionStub => {
	let opened = 0
	return {
		cursor: () => Promise.resolve(0),
		running: () => Promise.resolve(false),
		history: () => Promise.resolve([]),
		since: () => Promise.resolve([]),
		append: () => Promise.resolve(0),
		holdsTurn: () => Promise.resolve(false),
		endTurn: () => Promise.resolve(),
		abort: () => Promise.resolve(),
		beginTurn: () => Promise.resolve(undefined),
		subscribe: () => Promise.resolve(sse(connections[Math.min(opened++, connections.length - 1)] ?? [])),
	}
}

describe("chatTurnEvents", () => {
	it.effect("decodes the frames of one connection", () =>
		Effect.gen(function* () {
			const events = yield* Stream.runCollect(
				chatTurnEvents(
					stub([
						[
							event(1, { type: "turn-start", messageId: "a1" }),
							event(2, { type: "text-delta", messageId: "a1", text: "hi" }),
							event(3, { type: "turn-end", messageId: "a1", reason: "stop" }),
						],
					]),
					"org_1:bot-testchat-c1",
					0,
				).pipe(Stream.takeUntil((next) => next.type === "turn-end")),
			)

			expect(events.map((next) => next.seq)).toEqual([1, 2, 3])
		}),
	)

	it.effect("skips a frame it cannot read rather than ending the turn on it", () =>
		Effect.gen(function* () {
			// What a session one deploy ahead of this Worker sends: an event whose shape this build
			// has never seen. Ending the stream on it would cut the answer off mid-turn.
			const unknown = `id: 1\ndata: {"seq":1,"type":"turn-whatever","messageId":"a1"}\n\n`
			const ending = event(2, { type: "turn-end", messageId: "a1", reason: "stop" })
			const session: ChatSessionStub = {
				...stub([[]]),
				subscribe: () =>
					Promise.resolve(frames(`${unknown}id: 2\ndata: ${JSON.stringify(ending)}\n\n`)),
			}

			const events = yield* Stream.runCollect(
				chatTurnEvents(session, "org_1:bot-testchat-c1", 0).pipe(
					Stream.takeUntil((next) => next.type === "turn-end"),
				),
			)

			expect(events.map((next) => next.seq)).toEqual([2])
		}),
	)

	it.effect("reports a session it cannot subscribe to, so the turn can say so", () =>
		Effect.gen(function* () {
			const session: ChatSessionStub = {
				...stub([[]]),
				subscribe: () => Promise.reject(new Error("no such object")),
			}

			const error = yield* Effect.flip(
				Stream.runCollect(chatTurnEvents(session, "org_1:bot-testchat-c1", 0)),
			)

			expect(error).toBeInstanceOf(ChatSessionUnreachable)
		}),
	)
})

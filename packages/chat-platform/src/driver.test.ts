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

const target: ChatTarget = { workspaceId: "guild_1", channelId: "chan_1" }

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
						const ref = { target: postTarget, messageId: `m${++posted}` }
						calls.push({ verb: "post", ref, blocks })
						return ref
					}),
				edit: (ref, blocks) => Effect.sync(() => void calls.push({ verb: "edit", ref, blocks })),
				typing: (typingTarget) => Effect.sync(() => void typing.push(typingTarget.channelId)),
				// A platform where a thread is just replies to a message opens one without any I/O.
				openThread: (request) => Effect.succeed(request.anchorMessageId),
				// Neither is the driver's concern: by the time a turn is being rendered, the conversation
				// it belongs to has been decided and the model has already been given it.
				conversation: () => Effect.die("the driver asked which conversation this is"),
				history: () => Effect.die("the driver asked what was said earlier"),
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

/** Whatever the status line names, if a message is carrying one at all. */
const working = (blocks: ReadonlyArray<ChatBlock>): ReadonlyArray<string> =>
	blocks.flatMap((block) => (block.kind === "activity" ? block.tools.map((tool) => tool.label) : []))

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
					messageId: "a1",
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
			expect(chat.typing).toEqual(["chan_1"])
		}),
	)

	it.effect("shows the tool it is on while it works, and only the answer once it has", () =>
		Effect.gen(function* () {
			const chat = recorder()
			const fiber = yield* Effect.forkChild(
				driveChatTurn({
					events: timeline([
						[NOW, event(1, { type: "turn-start", messageId: "a1" })],
						[
							NOW,
							event(2, {
								type: "text-delta",
								messageId: "a1",
								text: "Let me look at the errors first.",
							}),
						],
						[
							NOW,
							event(3, {
								type: "tool-call",
								messageId: "a1",
								callId: "c1",
								name: "find_errors",
								label: "Finding errors",
								input: {},
							}),
						],
						[
							Duration.millis(1500),
							event(4, { type: "tool-result", messageId: "a1", callId: "c1", output: null }),
						],
						[
							NOW,
							event(5, {
								type: "text-delta",
								messageId: "a1",
								text: " Now I'll check the traces.",
							}),
						],
						[
							NOW,
							event(6, {
								type: "tool-call",
								messageId: "a1",
								callId: "c2",
								name: "search_traces",
								label: "Searching traces",
								input: {},
							}),
						],
						[
							Duration.millis(1500),
							event(7, { type: "tool-result", messageId: "a1", callId: "c2", output: null }),
						],
						[
							NOW,
							event(8, {
								type: "text-delta",
								messageId: "a1",
								text: " checkout times out on the database.",
							}),
						],
						[
							Duration.millis(1500),
							event(9, { type: "turn-end", messageId: "a1", reason: "stop" }),
						],
					]),
					messageId: "a1",
					outbound: chat.outbound,
					target,
					context,
				}),
			)

			yield* TestClock.adjust("6 seconds")
			yield* Fiber.join(fiber)

			// The first thing the reader sees after the placeholder: the tool, and none of the
			// narration the model wrote on its way into it.
			expect(chat.calls.find((call) => working(call.blocks).length > 0)?.blocks).toEqual([
				{ kind: "activity", tools: [{ label: "Finding errors", status: "running", detail: null }] },
			])
			const lines = chat.calls.map((call) => working(call.blocks))
			// One tool at a time, never the list of everything the turn touched on its way here.
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(1)
			// The two calls, in the order the turn made them. Repeats are a call whose status
			// changed under the same name, which is one line either way.
			expect(lines.flat().filter((label, index, all) => label !== all[index - 1])).toEqual([
				"Finding errors",
				"Searching traces",
			])
			// The words the model wrote to itself between its calls never reach the channel.
			for (const call of chat.calls) expect(prose(call.blocks)).not.toMatch(/Let me|Now I'll/)
			// The finished message is the answer and nothing else.
			expect(chat.calls[chat.calls.length - 1].blocks).toEqual([
				{ kind: "prose", markdown: "checkout times out on the database." },
			])
		}),
	)

	it.effect("says a turn that stopped without a word finished, not that it is still working", () =>
		Effect.gen(function* () {
			const chat = recorder()
			// A model that runs a tool and then stops: the turn ends on `stop` with no prose to show
			// for it, and the placeholder would otherwise be the channel's last word on the matter.
			yield* driveChatTurn({
				events: timeline([
					[NOW, event(1, { type: "turn-start", messageId: "a1" })],
					[
						NOW,
						event(2, {
							type: "tool-call",
							messageId: "a1",
							callId: "c1",
							name: "find_errors",
							label: "Finding errors",
							input: {},
						}),
					],
					[NOW, event(3, { type: "tool-result", messageId: "a1", callId: "c1", output: null })],
					[NOW, event(4, { type: "turn-end", messageId: "a1", reason: "stop" })],
				]),
				messageId: "a1",
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls[chat.calls.length - 1].blocks).toEqual([
				{ kind: "notice", tone: "info", text: "Finished without a reply." },
			])
		}),
	)

	it.effect("names a sub-agent by the agent it delegates to on the status line", () =>
		Effect.gen(function* () {
			const chat = recorder()
			const fiber = yield* Effect.forkChild(
				driveChatTurn({
					events: timeline([
						[NOW, event(1, { type: "turn-start", messageId: "a1" })],
						[
							NOW,
							event(2, {
								type: "tool-call",
								messageId: "a1",
								callId: "t1",
								name: "task_reviewer",
								input: {},
							}),
						],
						[
							NOW,
							event(3, {
								type: "turn-start",
								messageId: "s1",
								task: { id: "t1", agent: "reviewer", parentMessageId: "a1" },
							}),
						],
						[
							Duration.millis(1500),
							event(4, { type: "turn-end", messageId: "a1", reason: "stop" }),
						],
					]),
					messageId: "a1",
					outbound: chat.outbound,
					target,
					context,
				}),
			)

			yield* TestClock.adjust("3 seconds")
			yield* Fiber.join(fiber)

			// The delegation is a line on the same status block, named for the agent it runs.
			expect(chat.calls.find((call) => working(call.blocks).length > 0)?.blocks).toEqual([
				{
					kind: "activity",
					tools: [{ label: "Delegating to reviewer", status: "running", detail: "1 step" }],
				},
			])
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
				messageId: "a1",
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
				messageId: "a1",
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
				messageId: "a1",
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
					outcome: null,
				},
				{ kind: "notice", tone: "error", text: "Failed: upstream said no" },
			])
		}),
	)

	it.effect("leaves the controls live on a turn that stopped on a proposal", () =>
		Effect.gen(function* () {
			const chat = recorder()
			// What `ChatSession` records for a gated call: the proposal, then a turn that finished.
			yield* driveChatTurn({
				events: timeline([
					[NOW, event(1, { type: "turn-start", messageId: "a1" })],
					[
						NOW,
						event(2, {
							type: "tool-call",
							messageId: "a1",
							callId: "call_9",
							name: "create_dashboard",
							input: { name: "Checkout" },
							proposed: true,
						}),
					],
					[NOW, event(3, { type: "turn-end", messageId: "a1", reason: "stop" })],
				]),
				messageId: "a1",
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls[chat.calls.length - 1].blocks).toEqual([
				{
					kind: "approval",
					toolName: "create_dashboard",
					summary: "name: Checkout",
					token: "org_1:bot-42|call_9",
					outcome: null,
				},
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
				messageId: "a1",
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls.map((call) => call.verb)).toEqual(["post", "edit"])
			expect(chat.calls[1].blocks).toEqual([
				{ kind: "notice", tone: "error", text: "Failed: no model" },
			])
		}),
	)

	it.effect("spends no edit on a message that already says the right thing", () =>
		Effect.gen(function* () {
			const chat = recorder()
			const fiber = yield* Effect.forkChild(
				driveChatTurn({
					events: timeline([
						[NOW, event(1, { type: "turn-start", messageId: "a1" })],
						[NOW, event(2, { type: "text-delta", messageId: "a1", text: "Done." })],
						// Three throttle ticks with nothing new to say, then the close.
						[
							Duration.seconds(4),
							event(3, { type: "turn-end", messageId: "a1", reason: "stop" }),
						],
					]),
					messageId: "a1",
					outbound: chat.outbound,
					target,
					context,
				}),
			)

			yield* TestClock.adjust("5 seconds")
			yield* Fiber.join(fiber)

			// The placeholder, one edit carrying the answer, and nothing else — a turn cut into
			// several messages would otherwise rewrite each of them on every tick.
			expect(chat.calls.map((call) => call.verb)).toEqual(["post", "edit"])
		}),
	)

	it.effect("reports each message it posts, and a resume edits them rather than posting again", () =>
		Effect.gen(function* () {
			const events = [
				event(1, { type: "turn-start", messageId: "a1" }),
				event(2, { type: "text-delta", messageId: "a1", text: "line\n".repeat(30) }),
				event(3, { type: "turn-end", messageId: "a1", reason: "stop" }),
			]
			const first = recorder(80)
			const reported: Array<ReadonlyArray<string>> = []
			yield* driveChatTurn({
				events: Stream.fromIterable(events),
				messageId: "a1",
				outbound: first.outbound,
				target,
				context,
				onPosted: (messages) =>
					Effect.sync(() => void reported.push(messages.map((ref) => ref.messageId))),
			})
			// Every post, as the growing list a checkpoint is written from.
			const posts = first.calls.filter((call) => call.verb === "post").map((call) => call.ref.messageId)
			expect(posts.length).toBeGreaterThan(1)
			expect(reported).toEqual(posts.map((_, index) => posts.slice(0, index + 1)))

			const again = recorder(80)
			yield* driveChatTurn({
				events: Stream.fromIterable(events),
				messageId: "a1",
				outbound: again.outbound,
				target,
				context,
				posted: posts.map((messageId) => ({ target, messageId })),
			})
			// No placeholder, no typing, no second copy: one rewrite of each message it was handed.
			expect(again.typing).toEqual([])
			expect(again.calls.map((call) => `${call.verb} ${call.ref.messageId}`)).toEqual(
				posts.map((messageId) => `edit ${messageId}`),
			)
			const settled = new Map(first.calls.map((call) => [call.ref.messageId, call.blocks]))
			expect(again.calls.map((call) => call.blocks)).toEqual(
				posts.map((messageId) => settled.get(messageId)),
			)
		}),
	)

	it.effect("empties a message a retraction shrank the turn past", () =>
		Effect.gen(function* () {
			const chat = recorder(80)
			const long = "line\n".repeat(30)
			const fiber = yield* Effect.forkChild(
				driveChatTurn({
					events: timeline([
						[NOW, event(1, { type: "turn-start", messageId: "a1" })],
						[NOW, event(2, { type: "text-delta", messageId: "a1", text: long })],
						[
							Duration.seconds(2),
							event(3, {
								type: "turn-retry",
								messageId: "a1",
								attempt: 2,
								retractChars: long.length - 20,
								reason: "overloaded",
								delayMs: 0,
							}),
						],
						[
							Duration.seconds(2),
							event(4, { type: "turn-end", messageId: "a1", reason: "stop" }),
						],
					]),
					messageId: "a1",
					outbound: chat.outbound,
					target,
					context,
				}),
			)

			yield* TestClock.adjust("6 seconds")
			yield* Fiber.join(fiber)

			const second = chat.calls.filter((call) => call.ref.messageId === "m2")
			expect(second.length).toBeGreaterThan(1)
			// The follow-up message is emptied rather than left holding text the turn took back.
			expect(second[second.length - 1].blocks).toEqual([])
		}),
	)

	it.effect("says so when the event stream dies instead of leaving the placeholder up", () =>
		Effect.gen(function* () {
			const chat = recorder()
			const events = Stream.fromIterable([
				event(1, { type: "turn-start", messageId: "a1" }),
				event(2, { type: "text-delta", messageId: "a1", text: "Half an ans" }),
			]).pipe(Stream.concat(Stream.fail("the session went away")))

			const error = yield* Effect.flip(
				driveChatTurn({ events, messageId: "a1", outbound: chat.outbound, target, context }),
			)

			expect(error).toBe("the session went away")
			const last = chat.calls[chat.calls.length - 1].blocks
			expect(last[last.length - 1]).toMatchObject({ kind: "notice", tone: "error" })
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
				messageId: "a1",
				outbound: chat.outbound,
				target,
				context,
			})

			expect(chat.calls.filter((call) => call.verb === "post")).toHaveLength(1)
			expect(prose(chat.calls[chat.calls.length - 1].blocks)).toBe("Checking.")
		}),
	)
})

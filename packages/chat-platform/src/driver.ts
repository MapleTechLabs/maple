/**
 * One agent turn, streamed onto a chat platform.
 *
 * The driver holds the whole turn in one message (or the few it has to be cut into) and keeps
 * rewriting it, rather than posting a line at a time: a channel is shared with people, and a turn
 * that arrives as forty messages is unreadable and unrateable. That makes the loop
 *
 *   fold the events → render the turn → cut it to the platform's budget → edit what is posted
 *
 * run on every change, throttled to the platform's edit interval, and once more at the end. The
 * fold is `@maple/domain`'s, so a reconnect that replays from an older cursor lands on the same
 * transcript, and a `turn-retry` that retracts text the reader already saw is simply the next
 * render.
 */
import { makeChatTranscript } from "@maple/domain/chat-transcript"
import type { ChatEvent, ChatTurnEndEvent } from "@maple/domain/chat-session"
import { Clock, Effect, Fiber, Schedule, Semaphore, Stream } from "effect"
import type { ChatMessageRef, ChatOutbound, ChatOutboundError, ChatTarget } from "./outbound"
import {
	renderChatMessage,
	splitBlocks,
	type ChatBlock,
	type ChatNoticeBlock,
	type ChatRenderContext,
} from "./render"

export interface ChatTurnDriverOptions<E, RE, RO> {
	/** The turn's events, from seq 0 or from the cursor taken before it started. */
	readonly events: Stream.Stream<ChatEvent, E, RE>
	readonly outbound: ChatOutbound<RO>
	readonly target: ChatTarget
	readonly context: ChatRenderContext
}

export const driveChatTurn = <E, RE, RO>(
	options: ChatTurnDriverOptions<E, RE, RO>,
): Effect.Effect<void, E | ChatOutboundError, RE | RO> =>
	Effect.gen(function* () {
		const { context, outbound, target } = options
		const transport = yield* outbound.transport
		const transcript = makeChatTranscript()
		const posted: Array<ChatMessageRef> = []
		// One flush at a time: the throttle fiber and the final flush would otherwise race, and the
		// loser's edit would put a stale render back on a finished turn.
		const gate = yield* Semaphore.make(1)

		/** The turn's assistant message. Null until `turn-start`, which is also what posts anything. */
		let messageId: string | null = null
		let ending: ChatNoticeBlock | null = null
		let dirty = false

		const flush = gate.withPermit(
			Effect.gen(function* () {
				if (messageId === null) return
				dirty = false
				const message = transcript.messages.find((candidate) => candidate.id === messageId)
				const blocks: Array<ChatBlock> =
					message === undefined ? [] : [...renderChatMessage(message, context)]
				if (ending !== null) blocks.push(ending)
				if (blocks.length === 0) blocks.push(PENDING)

				const groups = splitBlocks(blocks, outbound.limits.maxMessageChars)
				for (let index = 0; index < Math.max(groups.length, posted.length); index++) {
					// A retraction can shrink a turn below a message it had already needed, so a surplus
					// message is emptied rather than left holding text the turn no longer says.
					const group = index < groups.length ? groups[index] : NO_BLOCKS
					if (index < posted.length) yield* transport.edit(posted[index], group)
					else posted.push(yield* transport.post(target, group))
				}
			}),
		)

		const onEvent = (event: ChatEvent) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				transcript.add(event, now)
				// Sub-agent events carry a `task` ref and belong to a nested transcript; the turn they
				// are nested in is the one being driven.
				if (event.type !== "user-message" && event.task !== undefined) {
					dirty = true
					return
				}
				if (event.type === "turn-end") {
					ending = turnEndNotice(event)
					return
				}
				if (event.type === "turn-start" && messageId === null) {
					messageId = event.messageId
					// The placeholder, immediately: the platform should show the bot working before the
					// first token lands, not after the first throttle interval.
					yield* flush
					return
				}
				dirty = true
			})

		yield* Effect.forkChild(Effect.ignore(transport.typing(target)))
		const throttled = yield* Effect.forkChild(
			Effect.repeat(
				Effect.suspend(() => (dirty ? flush : Effect.void)),
				{ schedule: Schedule.spaced(outbound.limits.minEditInterval) },
			),
		)

		yield* Stream.runForEach(options.events.pipe(Stream.takeUntil(isTurnEnd)), onEvent)
		yield* Fiber.interrupt(throttled)
		yield* flush
	}).pipe(Effect.withSpan("ChatPlatform.driveChatTurn"))

const NO_BLOCKS: ReadonlyArray<ChatBlock> = []

const PENDING: ChatNoticeBlock = { kind: "notice", tone: "pending", text: "Working on it…" }

const isTurnEnd = (event: ChatEvent): boolean => event.type === "turn-end" && event.task === undefined

/** How much of a failure's own message a channel is worth showing. */
const MAX_ERROR_CHARS = 200

/**
 * The line a turn that did not simply finish ends on.
 *
 * Neutral and short on purpose: the reader is in a channel, not in a log viewer, and the one thing
 * they need to know is whether the answer above them is complete.
 */
const turnEndNotice = (event: ChatTurnEndEvent): ChatNoticeBlock | null => {
	switch (event.reason) {
		case "stop":
			return null
		case "aborted":
			return { kind: "notice", tone: "info", text: "Stopped before finishing." }
		case "max-steps":
			return {
				kind: "notice",
				tone: "info",
				text: "Stopped at the step limit — a narrower question will get further.",
			}
		case "error":
			return {
				kind: "notice",
				tone: "error",
				text:
					event.error === undefined
						? "Failed before finishing."
						: `Failed: ${event.error.slice(0, MAX_ERROR_CHARS)}`,
			}
	}
}

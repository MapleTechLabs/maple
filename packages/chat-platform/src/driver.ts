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
import { Cause, Clock, Effect, Fiber, Schedule, Semaphore, Stream } from "effect"
import type { ChatMessageRef, ChatOutbound, ChatTarget } from "./outbound"
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
	/**
	 * The assistant message this turn writes — what `beginTurn` answered with.
	 *
	 * Named rather than discovered from the first `turn-start`, because a stream from seq 0 replays
	 * whole earlier turns: a driver watching for any `turn-start` would adopt an old message, and one
	 * watching for any `turn-end` would stop on an old turn's ending before this one had said a word.
	 */
	readonly messageId: string
	readonly outbound: ChatOutbound<RO>
	readonly target: ChatTarget
	readonly context: ChatRenderContext
	/** Messages an earlier run posted for this turn: edited in place, and no placeholder. */
	readonly posted?: ReadonlyArray<ChatMessageRef>
	/** Told every message posted so far, each time one is added — what `posted` comes from. */
	readonly onPosted?: (messages: ReadonlyArray<ChatMessageRef>) => Effect.Effect<void>
}

export const driveChatTurn = Effect.fn("ChatPlatform.driveChatTurn")(function* <E, RE, RO>(
	options: ChatTurnDriverOptions<E, RE, RO>,
) {
	const { context, messageId, outbound, target } = options
	yield* Effect.annotateCurrentSpan({
		"chat.connector": outbound.connectorId,
		"chat.session_id": context.sessionId,
		"chat.message_id": messageId,
	})

	const transport = yield* outbound.transport
	const transcript = makeChatTranscript()
	const posted: Array<ChatMessageRef> = [...(options.posted ?? [])]
	const resumed = posted.length > 0
	/** What each posted message currently holds, so an unchanged one is not edited again. */
	const sent: Array<string> = []
	// One flush at a time: the throttle fiber and the final flush would otherwise race, and the
	// loser's edit would put a stale render back on a finished turn.
	const gate = yield* Semaphore.make(1)

	// Turn state, mutated by the stream fiber and read by the throttle fiber. Safe without a `Ref`
	// because fibers interleave only at yield points within one isolate, and everything that reads
	// the transcript does so under `gate`: `dirty` is cleared BEFORE the render, so an event that
	// lands during a post or an edit marks the turn dirty again rather than being swallowed.
	let ending: ChatNoticeBlock | null = null
	/** How the turn closed, for the span — the one place a failed turn is more than a line of copy. */
	let endReason = "unfinished"
	let dirty = false
	/**
	 * What the render is of: a turn in progress, or the message it settles as.
	 *
	 * The exception to the note above — it is cleared by this fiber once the throttle fiber has
	 * been interrupted, so no flush can read it half way through a turn it has not finished.
	 */
	let running = true

	const flush = gate.withPermit(
		Effect.gen(function* () {
			// Messages an earlier run posted already say more than a render of no events would.
			if (resumed && transcript.seq === 0) return
			dirty = false
			const message = transcript.messages.find((candidate) => candidate.id === messageId)
			const blocks: Array<ChatBlock> =
				message === undefined ? [] : [...renderChatMessage(message, context, running)]
			if (ending !== null) blocks.push(ending)
			// A finished turn must never be left under the placeholder: a model that stops after a
			// tool call without a closing word renders as nothing at all, and "Working on it…" would
			// then be the last thing the channel ever says about it.
			if (blocks.length === 0) blocks.push(running ? PENDING : NOTHING_SAID)

			const groups = splitBlocks(blocks, outbound.limits.maxMessageChars)
			for (let index = 0; index < Math.max(groups.length, posted.length); index++) {
				// A retraction can shrink a turn below a message it had already needed, so a surplus
				// message is emptied rather than left holding text the turn no longer says.
				const group = index < groups.length ? groups[index] : NO_BLOCKS
				// A fingerprint of what this message should now say, not a wire format — nothing decodes
				// it, it is only ever compared with the previous flush's.
				// oxlint-disable-next-line effecttsgo/prefer-schema-over-json
				const rendered = JSON.stringify(group)
				if (index >= posted.length) {
					posted.push(yield* transport.post(target, group))
					sent.push(rendered)
					// At least once: a run lost between the post and this report posts it again later.
					if (options.onPosted !== undefined) yield* options.onPosted([...posted])
					continue
				}
				// Only what changed. A turn cut into three messages would otherwise spend three edits
				// per tick, almost all of them rewriting a message with what it already says — and a
				// platform's edit budget is per channel, not per message.
				if (sent[index] === rendered) continue
				yield* transport.edit(posted[index], group)
				sent[index] = rendered
			}
		}),
	)

	const onEvent = Effect.fnUntraced(function* (event: ChatEvent) {
		const now = yield* Clock.currentTimeMillis
		transcript.add(event, now)
		// Sub-agent events carry a `task` ref and belong to a nested transcript; the turn they are
		// nested in is the one being driven.
		if (event.type !== "user-message" && event.task !== undefined) {
			dirty = true
			return
		}
		if (event.type === "turn-end" && event.messageId === messageId) {
			ending = turnEndNotice(event)
			endReason = event.reason
			return
		}
		dirty = true
	})

	yield* Effect.forkChild(
		// Best effort by nature, so the failure is a debug line and not even its tag: nothing acts on
		// a missing typing indicator.
		transport.typing(target).pipe(
			Effect.tapCause(() => Effect.logDebug("Typing could not be shown")),
			Effect.ignore,
		),
	)
	// The placeholder, before a single event: the platform should show the bot working on it rather
	// than saying nothing until the first token, or until the first throttle interval.
	yield* flush
	const throttled = yield* Effect.forkChild(
		Effect.repeat(
			// A mid-turn edit that fails takes its fiber with it and nothing joins this one, so the
			// cause is logged here or it is lost. The final flush still runs, and still reports.
			Effect.suspend(() => (dirty ? flush : Effect.void)).pipe(
				Effect.tapCause(report("A turn's message could not be updated")),
			),
			{ schedule: Schedule.spaced(outbound.limits.minEditInterval) },
		),
	)

	// `takeUntil` is inclusive, so THIS turn's `turn-end` reaches the fold and sets the closing
	// notice before the stream completes. An earlier turn's does not stop the stream.
	const endsThisTurn = (event: ChatEvent) =>
		event.type === "turn-end" && event.task === undefined && event.messageId === messageId
	const outcome = yield* Stream.runForEach(
		options.events.pipe(Stream.takeUntil(endsThisTurn)),
		onEvent,
	).pipe(
		// A stream that dies has no `turn-end` to close on, and the reader would be left looking at
		// the placeholder forever. Say so, flush, and then fail.
		Effect.tapError(() =>
			Effect.sync(() => {
				if (ending === null) ending = DISCONNECTED
			}),
		),
		Effect.exit,
	)
	yield* Fiber.interrupt(throttled)
	// Whatever ended the turn, the last render is the finished message: the answer, and none of the
	// working. Set here rather than on `turn-end`, so a stream that died — and never reaches one —
	// settles the same way.
	running = false
	yield* flush
	yield* Effect.annotateCurrentSpan({ "chat.turn.end_reason": endReason, "chat.messages": posted.length })
	return yield* outcome
})

/**
 * What failed, never what it carried.
 *
 * An outbound failure holds the request it failed on, and that request's body is the turn being
 * posted — so a rendered cause on this path writes a customer's conversation into a log line.
 */
const report = (message: string) => (cause: Cause.Cause<unknown>) =>
	Effect.logWarning(message).pipe(
		Effect.annotateLogs({
			"error.type": Cause.prettyErrors(cause)
				.map((error) => error.name)
				.join(";"),
		}),
	)

const NO_BLOCKS: ReadonlyArray<ChatBlock> = []

const PENDING: ChatNoticeBlock = { kind: "notice", tone: "pending", text: "Working on it…" }

/** A turn that ran to its end and wrote nothing to show for it. Rare, and never silent. */
const NOTHING_SAID: ChatNoticeBlock = {
	kind: "notice",
	tone: "info",
	text: "Finished without a reply.",
}

const DISCONNECTED: ChatNoticeBlock = {
	kind: "notice",
	tone: "error",
	text: "Lost the connection to the agent — this answer stops here.",
}

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

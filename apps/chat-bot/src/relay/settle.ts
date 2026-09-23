/**
 * Settling a turn whose relay object was evicted mid-turn.
 *
 * The turn keeps running in the chat session; only the fiber rendering it is lost. So the relay
 * checkpoints the platform messages it posted, and a later activation waits for the session to end
 * the turn and renders the final answer into those same messages once. No turn text is stored.
 */
import { driveChatTurn } from "@maple/chat-platform"
import { ChatSessionId } from "@maple/domain/chat-session"
import { ChatConnectorId } from "@maple/domain/primitives"
import { Clock, Effect, Option, Schema, Stream } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { sessionUnreachable } from "./events.ts"
import type { RelayPorts } from "./turn.ts"

const ChatTargetSchema = Schema.Struct({
	workspaceId: Schema.String,
	channelId: Schema.String,
	// `ChatTarget` allows an explicit `undefined`, and storage keeps it.
	threadId: Schema.optional(Schema.String),
})

export const RelayTurnCheckpoint = Schema.Struct({
	connector: ChatConnectorId,
	sessionId: ChatSessionId,
	turnMessageId: Schema.String,
	/** The cursor the turn was claimed at: its events are the ones after it. */
	cursor: Schema.Int,
	target: ChatTargetSchema,
	/** The platform messages posted for this turn, in order. */
	messages: Schema.Array(Schema.Struct({ target: ChatTargetSchema, messageId: Schema.String })),
	recordedAt: Schema.Int,
})
export type RelayTurnCheckpoint = typeof RelayTurnCheckpoint.Type

export const decodeRelayTurnCheckpoint = Schema.decodeUnknownOption(RelayTurnCheckpoint)

/** The session's `TURN_STALE_MS` (25 min, when it expires a turn nobody ended) plus a margin. */
const CHECKPOINT_TTL_MS = 30 * 60 * 1000

/** `"pending"`: the session is still running the turn, so the checkpoint waits for the next alarm. */
export type SettleOutcome = "pending" | "done"

/** Anything that goes wrong is logged once, the cause summarized, and the checkpoint dropped. */
export const settleRelayedTurn = Effect.fn("chat_bot.settle_turn")(
	function* <R>(checkpoint: RelayTurnCheckpoint, ports: RelayPorts<R>) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.session_id": checkpoint.sessionId })
		const done: SettleOutcome = "done"
		const session = ports.chatSession(checkpoint.sessionId)
		const expired = (yield* Clock.currentTimeMillis) - checkpoint.recordedAt > CHECKPOINT_TTL_MS
		if (expired || session === undefined) return done
		const unreachable = sessionUnreachable(checkpoint.sessionId, "The chat session could not be read")
		const events = yield* Effect.tryPromise({
			try: () => session.since(checkpoint.cursor),
			catch: unreachable,
		})
		// Ended when its own `turn-end` is in the log — `running()` alone would also wait out a newer
		// turn in the same session.
		const ended = events.some(
			(event) =>
				event.type === "turn-end" &&
				event.task === undefined &&
				event.messageId === checkpoint.turnMessageId,
		)
		if (!ended && (yield* Effect.tryPromise({ try: () => session.running(), catch: unreachable }))) {
			const pending: SettleOutcome = "pending"
			return pending
		}
		// A session with nothing after the cursor is not the one that ran this turn.
		if (events.length === 0) {
			yield* Effect.logWarning("A relayed turn's session has no events to settle it from")
			return done
		}
		const workspace = yield* ports.resolveWorkspace(checkpoint.connector, checkpoint.target.workspaceId)
		if (Option.isNone(workspace)) return done
		// The driver's own final render, into the messages already posted: surplus ones emptied, a
		// tail the answer outgrew them by posted.
		yield* driveChatTurn({
			events: Stream.fromIterable(events),
			messageId: checkpoint.turnMessageId,
			outbound: ports.outbound,
			target: checkpoint.target,
			context: {
				appBaseUrl: ports.appBaseUrl,
				sessionId: checkpoint.sessionId,
				chartImageUrl: (ref) => ports.chartImageUrl(workspace.value.orgId, ref),
			},
			posted: checkpoint.messages,
			onPosted: (messages) => ports.recordTurn({ ...checkpoint, messages }),
		})
		return done
	},
	(effect, checkpoint) =>
		Effect.catchCause(effect, (cause) =>
			Effect.logError("A relayed turn could not be settled").pipe(
				Effect.annotateLogs({
					"maple.chat.connector": checkpoint.connector,
					"error.type": summarizeCause(cause),
				}),
				Effect.as<SettleOutcome>("done"),
			),
		),
)

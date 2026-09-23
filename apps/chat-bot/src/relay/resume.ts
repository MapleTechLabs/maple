/**
 * Picking a relayed turn back up after the object relaying it was evicted.
 *
 * The turn itself never stops — it runs inside the chat session, whose own heartbeat keeps it
 * alive — but the fiber rendering it into the conversation dies with the object, and the channel is
 * left holding whatever the last edit said. So the relay keeps a checkpoint: the turn's identity,
 * where its events start, and the platform messages it has posted. Nothing the turn SAID is in it:
 * the session still has every event, and replaying them from the same cursor folds the same
 * transcript the lost fiber had.
 *
 * A resume therefore edits the messages the checkpoint names and posts only what the turn has
 * outgrown them by. The one exception is a message posted and lost before its checkpoint was
 * written, which is posted again (see `driveChatTurn`'s `onPosted`).
 */
import { driveChatTurn } from "@maple/chat-platform"
import { ChatSessionId } from "@maple/domain/chat-session"
import { ChatConnectorId } from "@maple/domain/primitives"
import { Clock, Duration, Effect, Exit, Option, Schema } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { chatTurnEvents } from "./events.ts"
import type { RelayPorts } from "./turn.ts"

const ChatTargetSchema = Schema.Struct({
	workspaceId: Schema.String,
	channelId: Schema.String,
	// `ChatTarget` allows an explicit `undefined`, and storage keeps it.
	threadId: Schema.optional(Schema.String),
})

/** What a later activation needs to go on rendering a turn, in the relay object's storage. */
export const RelayTurnCheckpoint = Schema.Struct({
	connector: ChatConnectorId,
	sessionId: ChatSessionId,
	turnMessageId: Schema.String,
	/** The cursor the turn was claimed at — replaying from it rebuilds the lost fiber's fold. */
	cursor: Schema.Int,
	target: ChatTargetSchema,
	/** The platform messages the driver posted for this turn, in order. */
	messages: Schema.Array(Schema.Struct({ target: ChatTargetSchema, messageId: Schema.String })),
	/** Epoch ms after which the turn is not worth relaying any more: its start plus the relay timeout. */
	deadline: Schema.Int,
	/** How many activations have already tried to resume it. */
	resumes: Schema.Int,
})
export type RelayTurnCheckpoint = typeof RelayTurnCheckpoint.Type

/** A stored value this build can no longer read is dropped by the caller, never thrown on. */
export const decodeRelayTurnCheckpoint = Schema.decodeUnknownOption(RelayTurnCheckpoint)

/**
 * How many activations may try one turn. An eviction is rare; the same turn losing three objects
 * in a row is something that will keep happening, and the reader is better served by the message
 * as it stands than by a loop.
 */
const MAX_RESUMES = 3

/** The relay's ports a resume reaches — none of the ones only a new event asks. */
export type ResumePorts<R> = Pick<
	RelayPorts<R>,
	"outbound" | "resolveWorkspace" | "chatSession" | "appBaseUrl" | "chartImageUrl" | "recordTurn"
>

const resume = Effect.fn("chat_bot.resume_turn")(function* <R>(
	checkpoint: RelayTurnCheckpoint,
	ports: ResumePorts<R>,
) {
	yield* Effect.annotateCurrentSpan({
		"maple.chat.connector": checkpoint.connector,
		"maple.chat.session_id": checkpoint.sessionId,
		"maple.chat.resumes": checkpoint.resumes,
		"maple.chat.messages": checkpoint.messages.length,
	})
	const now = yield* Clock.currentTimeMillis
	if (checkpoint.resumes >= MAX_RESUMES || now >= checkpoint.deadline) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.resume": "expired" })
	}
	// Counted before the work, so an activation that is itself evicted still spends its attempt.
	const resumed = { ...checkpoint, resumes: checkpoint.resumes + 1 }
	yield* ports.recordTurn(resumed)

	// The same lookup a new event makes: it is what the transport's credential came from, and a
	// workspace unlinked since the turn began is no longer one to write into.
	const workspace = yield* Effect.exit(
		ports.resolveWorkspace(checkpoint.connector, checkpoint.target.workspaceId),
	)
	if (Exit.isFailure(workspace) || Option.isNone(workspace.value)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.resume": "unavailable" })
	}
	const { orgId } = workspace.value.value
	const session = ports.chatSession(checkpoint.sessionId)
	if (session === undefined) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.resume": "no_binding" })
	}

	yield* Effect.annotateCurrentSpan({ orgId, "maple.chat.resume": "started" })
	// A turn that ended while nobody was relaying it replays straight through its `turn-end`, which
	// makes this one settling render. A session that is gone fails the subscription before anything
	// replays, and the messages are left as they were. The timeout interrupts the driver, exactly as
	// the relay's own does, so a turn that outlives its deadline gets no settling render.
	yield* driveChatTurn({
		events: chatTurnEvents(session, checkpoint.sessionId, checkpoint.cursor),
		messageId: checkpoint.turnMessageId,
		outbound: ports.outbound,
		target: checkpoint.target,
		context: {
			appBaseUrl: ports.appBaseUrl,
			sessionId: checkpoint.sessionId,
			chartImageUrl: (ref) => ports.chartImageUrl(orgId, ref),
		},
		posted: checkpoint.messages,
		onPosted: (messages) => ports.recordTurn({ ...resumed, messages }),
	}).pipe(Effect.timeout(Duration.millis(checkpoint.deadline - now)))
})

/**
 * Resume one checkpointed turn, with nothing left for the caller to handle but clearing it.
 *
 * Logged like a relayed event's failure — the cause summarized, never rendered — and once: the
 * caller drops the checkpoint whatever this answers.
 */
export const resumeRelayedTurn = <R>(
	checkpoint: RelayTurnCheckpoint,
	ports: ResumePorts<R>,
): Effect.Effect<void, never, R> =>
	resume(checkpoint, ports).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("A relayed turn could not be resumed").pipe(
				Effect.annotateLogs({
					"maple.chat.connector": checkpoint.connector,
					"maple.chat.workspace_id": checkpoint.target.workspaceId,
					"error.type": summarizeCause(cause),
				}),
			),
		),
	)

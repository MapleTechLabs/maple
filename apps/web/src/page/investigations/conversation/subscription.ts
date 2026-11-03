import { Clock, Effect, Schema, Stream } from "effect"
import type { MapleSyncHttpClient } from "../../../platform/api-clients"
import { tailEvents } from "./kit/chat-api"
import { Message } from "./message"
import type { Model } from "./model"

// The investigation conversation's live tail while a turn runs, as a Subscription dependency.

export const Tail = Schema.Struct({
	sessionId: Schema.String,
	generation: Schema.Number,
	cursor: Schema.Number,
})
export type Tail = typeof Tail.Type

export const tailOf = (model: Model): Tail | null =>
	model.stream === null
		? null
		: { sessionId: model.sessionId, generation: model.stream.generation, cursor: model.stream.cursor }

/**
 * The tail's Messages, each stamped with the clock (a new assistant turn's `createdAt`). A
 * restarted tail reconnects from its cursor; the reducer drops the events it already folded by seq.
 */
export const tailMessages = <M>(
	tail: Tail,
	toMessage: (message: Message) => M,
): Stream.Stream<M, never, MapleSyncHttpClient> =>
	tailEvents(tail.sessionId, tail.cursor).pipe(
		Stream.mapEffect((output) =>
			Effect.map(Clock.currentTimeMillis, (nowMs) =>
				toMessage(
					output._tag === "Events"
						? Message.ReceivedChatEvents({
								generation: tail.generation,
								events: output.events,
								nowMs,
							})
						: Message.FailedChatStream({ generation: tail.generation, message: output.message }),
				),
			),
		),
	)

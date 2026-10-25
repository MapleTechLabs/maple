import { Clock, Effect, Schema, Stream } from "effect"
import type { MapleSyncHttpClient } from "../../../platform/api-clients"
import { tailEvents } from "../kit/chat-api"
import { Message } from "./message"
import type { Model } from "./model"

// The live tails of every conversation with a turn running, as one Subscription dependency.

export const Tail = Schema.Struct({
	tabId: Schema.String,
	sessionId: Schema.String,
	generation: Schema.Number,
	cursor: Schema.Number,
})
export type Tail = typeof Tail.Type

export const tailOf = (model: Model): ReadonlyArray<Tail> =>
	model.stream === null
		? []
		: [{ tabId: model.tabId, sessionId: model.sessionId, generation: model.stream.generation, cursor: model.stream.cursor }]

/**
 * One tail's Messages, each stamped with the clock (a new assistant turn's `createdAt`). A tail
 * restarted because another conversation's started reconnects from its cursor; the reducer drops
 * the events it already folded by seq.
 */
export const tailMessages = <M>(
	tail: Tail,
	toMessage: (tabId: string, message: Message) => M,
): Stream.Stream<M, never, MapleSyncHttpClient> =>
	tailEvents(tail.sessionId, tail.cursor).pipe(
		Stream.mapEffect((output) =>
			Effect.map(Clock.currentTimeMillis, (nowMs) =>
				toMessage(
					tail.tabId,
					output._tag === "Events"
						? Message.ReceivedChatEvents({ generation: tail.generation, events: output.events, nowMs })
						: Message.FailedChatStream({ generation: tail.generation, message: output.message }),
				),
			),
		),
	)

export const tailsMessages = <M>(
	tails: ReadonlyArray<Tail>,
	toMessage: (tabId: string, message: Message) => M,
): Stream.Stream<M, never, MapleSyncHttpClient> =>
	Stream.mergeAll(
		tails.map((tail) => tailMessages(tail, toMessage)),
		{ concurrency: "unbounded" },
	)

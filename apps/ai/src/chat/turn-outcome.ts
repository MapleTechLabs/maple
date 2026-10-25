/**
 * How a turn ended, as its `chat.turn` span records it, and how an abort reaches the running turn.
 */
import { type ChatAbortReason, isChatAbortReason } from "@maple/domain/chat-session-stub"
import { Effect, Option } from "effect"

/**
 * Low-cardinality facts collected during the run and emitted once on the turn span.
 *
 * Mutable because the run discovers its outcome after the caller has already created the span.
 */
export interface TurnObservability {
	outcome?: "stop" | "aborted" | "error" | "max-steps" | "abandoned" | "resume_skipped" | "unknown"
	failureReason?: string
	/** Model-context compactions across the pass and its close-out; see `ChatRunOutcome`. */
	compactions?: number
}

export const makeTurnObservability = (): TurnObservability => ({})

/** The reason the session aborted the turn with, once it has. */
export const abortReason = (signal: AbortSignal | undefined): Option.Option<ChatAbortReason> =>
	signal?.aborted === true && isChatAbortReason(signal.reason) ? Option.some(signal.reason) : Option.none()

/** An abandoned turn is one the object was evicted from too often to start again. */
const abortReasonOf = (
	observability: TurnObservability,
	signal: AbortSignal | undefined,
): Option.Option<ChatAbortReason> => {
	if (observability.outcome === "abandoned") return Option.some("evicted")
	return observability.outcome === "aborted" ? abortReason(signal) : Option.none()
}

export const turnSpanAttributes = (
	observability: TurnObservability,
	signal: AbortSignal | undefined,
): Record<string, string | number> => ({
	"maple.chat.outcome": observability.outcome ?? "unknown",
	...(observability.compactions === undefined
		? undefined
		: { "maple.chat.compactions": observability.compactions }),
	...(observability.failureReason === undefined
		? undefined
		: { "maple.chat.failure_reason": observability.failureReason }),
	...Option.match(abortReasonOf(observability, signal), {
		onNone: () => undefined,
		onSome: (reason) => ({ "maple.chat.abort_reason": reason }),
	}),
})

const aborted = (signal: AbortSignal): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		if (signal.aborted) return resume(Effect.void)
		const onAbort = () => resume(Effect.void)
		signal.addEventListener("abort", onAbort, { once: true })
		return Effect.sync(() => signal.removeEventListener("abort", onAbort))
	})

/**
 * Interrupt `self` as soon as the session aborts the turn, sub-agents and in-flight model calls
 * included, and record the turn as aborted. Waiting for the run's next event let a superseded
 * review's `review_files` workers run on for minutes.
 */
export const interruptOnAbort =
	(signal: AbortSignal | undefined, observability: TurnObservability) =>
	<E, R>(self: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> =>
		signal === undefined
			? self
			: Effect.raceFirst(
					self,
					aborted(signal).pipe(
						Effect.andThen(
							Effect.suspend(() => {
								observability.outcome = "aborted"
								return Effect.annotateCurrentSpan(turnSpanAttributes(observability, signal))
							}),
						),
					),
				)

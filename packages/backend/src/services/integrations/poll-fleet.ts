// The fan-out every integration poller runs once per tick: work each org (or connector, or site)
// concurrently, and keep one member's failure from ending the tick.

import { Cause, Effect } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

/** Orgs one poller tick works at once: each holds outbound connections the Postgres pool shares. */
export const POLL_ORG_CONCURRENCY = 3

/**
 * Isolate one fleet member: a failure or defect is logged under `message` and replaced by
 * `fallback`. Interruption is re-raised so a cancelled tick stops instead of logging phantom failures.
 */
export const isolatePollFailure =
	<B>(message: string, annotations: Record<string, unknown>, fallback: B) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
		self.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(message).pipe(
							Effect.annotateLogs({ ...annotations, error: summarizeCause(cause) }),
							Effect.as(fallback),
						),
			),
		)

export interface PollFleetFailure<T, A> {
	/** The warning logged for a failed member. */
	readonly message: string
	readonly annotations: (member: T) => Record<string, unknown>
	/** What a failed member reports in place of its result. */
	readonly fallback: (member: T) => A
}

/** Poll every member, {@link isolatePollFailure} around each; results keep the members' order. */
export const pollFleet = <T, A, E, R>(
	members: Iterable<T>,
	poll: (member: T) => Effect.Effect<A, E, R>,
	onFailure: PollFleetFailure<T, A>,
	concurrency: number = POLL_ORG_CONCURRENCY,
): Effect.Effect<Array<A>, never, R> =>
	Effect.forEach(
		members,
		(member) =>
			poll(member).pipe(
				isolatePollFailure(
					onFailure.message,
					onFailure.annotations(member),
					onFailure.fallback(member),
				),
			),
		{ concurrency },
	)

import { type Duration, Effect, Exit, Fiber, Scope } from "effect"

/**
 * Closes `scope` and waits for it at most `timeout`. The close runs detached, so a finalizer stuck
 * in an uninterruptible region (an inspector command waiting out its own timeout) keeps running in
 * the background instead of holding the caller past its budget.
 */
export const closeWithin = (scope: Scope.Closeable, timeout: Duration.Input): Effect.Effect<void> =>
	Effect.forkDetach(Scope.close(scope, Exit.void)).pipe(
		Effect.flatMap((closing) => Effect.timeoutOption(Fiber.await(closing), timeout)),
		Effect.asVoid,
	)

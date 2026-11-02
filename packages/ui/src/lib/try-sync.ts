import { Effect, Option, Schema } from "effect"

/** A throw or rejection captured by `trySync` / `tryPromise`; callers only see `None`. */
class ThrownError extends Schema.TaggedError<ThrownError>()("@maple/ui/lib/ThrownError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * A throwing synchronous call as a total `Option`.
 *
 * The DOM is full of calls that throw rather than return a failure — `JSON.parse`
 * on a truncated body, `localStorage` in private mode, `execCommand` in a
 * sandboxed frame, a `getContext("2d")` a hardened browser refuses. `Effect.try`
 * moves the throw into the error channel and `Effect.option` discards it, so the
 * caller branches on a value the type system can see instead of on control flow
 * it cannot.
 *
 * Costs ~0.5µs per call against ~0.05µs for a bare `try`/`catch`. That is fine
 * everywhere it is used here; a genuinely hot loop should hoist the decision out
 * rather than reach back for a `catch` block.
 */
export const trySync = <A>(thunk: () => A): Option.Option<A> =>
	Effect.runSync(
		Effect.option(
			Effect.try({
				try: thunk,
				catch: (cause) => new ThrownError({ message: "Synchronous call threw", cause }),
			}),
		),
	)

/**
 * The async twin, for a promise that rejects rather than a call that throws.
 * Resolves to `None` on rejection.
 */
export const tryPromise = <A>(thunk: () => Promise<A>): Promise<Option.Option<A>> =>
	Effect.runPromise(
		Effect.option(
			Effect.tryPromise({
				try: thunk,
				catch: (cause) => new ThrownError({ message: "Promise rejected", cause }),
			}),
		),
	)

import { Effect, Result } from "effect"

/**
 * Spans `self` as `name`, ending it Ok when the lockfile is unreadable: a broken or unsupported file is the
 * repository's input, not a fault here. The error's tag lands on `lockfiles.unreadable`; the error still propagates.
 */
export const parseSpan =
	(name: string) =>
	<A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		self.pipe(
			Effect.result,
			Effect.tap((result) =>
				Result.isFailure(result)
					? Effect.annotateCurrentSpan("lockfiles.unreadable", result.failure._tag)
					: Effect.void,
			),
			Effect.withSpan(name),
			Effect.flatMap(Effect.fromResult),
		)

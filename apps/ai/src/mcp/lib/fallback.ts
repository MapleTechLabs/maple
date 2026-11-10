import { Effect, Predicate } from "effect"

/**
 * For a lookup that only enriches a tool's answer: on failure, log it at Warn under `lookup` and
 * answer with `fallback`, so the call neither fails nor loses the reason silently.
 */
export const orFallback =
	<B>(lookup: string, fallback: () => B) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
		self.pipe(
			Effect.tapError((error) =>
				Effect.logWarning("MCP lookup failed; answering without it").pipe(
					Effect.annotateLogs({
						"maple.mcp.lookup": lookup,
						"error.type":
							Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
								? error._tag
								: "unknown",
						"error.message":
							Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
								? error.message
								: String(error),
					}),
				),
			),
			Effect.orElseSucceed(fallback),
		)

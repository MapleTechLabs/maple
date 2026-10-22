import { Effect, Result } from "effect"
import type { ClerkUserResource } from "../../../platform/clerk"
import {
	type ClerkActionError,
	clerkTry,
	clerkTryReverified,
	currentClerkUser,
} from "../../../platform/clerk"

// The `/account` tabs' writes: a call on the signed-in Clerk user, settled into a message with
// Clerk's own failure text.

export const withUser = <A>(
	fallback: string,
	run: (user: ClerkUserResource) => Promise<A>,
): Effect.Effect<A, ClerkActionError> =>
	Effect.flatMap(currentClerkUser, (user) => clerkTry(fallback, () => run(user)))

/** `useReverification`: a write Clerk refuses for a stale session opens its challenge, then retries. */
export const withUserReverified = <A>(
	fallback: string,
	run: (user: ClerkUserResource) => Promise<A>,
): Effect.Effect<A, ClerkActionError> =>
	Effect.flatMap(currentClerkUser, (user) => clerkTryReverified(fallback, () => run(user)))

/** The write's outcome as `Result<void, message>` for a Completed message. */
export const settled =
	<B>(toMessage: (result: Result.Result<void, string>) => B) =>
	<A>(effect: Effect.Effect<A, ClerkActionError>): Effect.Effect<B> =>
		effect.pipe(
			Effect.asVoid,
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map(toMessage),
		)

import { Cause, Option, Predicate } from "effect"
import type * as AsyncResult from "effect/reactivity/AsyncResult"

export type DigestSubscriptionLoad<A> =
	| { readonly status: "loading" }
	/** `saved: null` is a user who never subscribed, so Maple's defaults apply. */
	| { readonly status: "ready"; readonly saved: A | null }
	| { readonly status: "failed"; readonly cause: Cause.Cause<unknown> }

const DIGEST_NOT_FOUND = "@maple/http/errors/DigestNotFoundError"

/**
 * A 404 is the expected "no subscription yet" answer, not a failure. Any other error
 * means the stored preferences are unknown, and editable switches built on defaults
 * would upsert over them.
 */
export function readDigestSubscription<A, E>(
	result: AsyncResult.AsyncResult<A, E>,
): DigestSubscriptionLoad<A> {
	if (result._tag === "Initial") return { status: "loading" }
	if (result._tag === "Success") return { status: "ready", saved: result.value }
	const error = Cause.findErrorOption(result.cause)
	return Option.isSome(error) && Predicate.isTagged(error.value, DIGEST_NOT_FOUND)
		? { status: "ready", saved: null }
		: { status: "failed", cause: result.cause }
}

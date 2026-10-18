import { Effect, Option, Predicate, Schema } from "effect"
import type { ClerkOrganizationResource, ClerkUserResource } from "./clerk"

// clerk-js resources for the Clerk-only settings tabs and `/account`: ported markup over the
// vanilla resource API (`useUser()`/`useOrganization()` in apps/web read the same objects).

export class ClerkActionError extends Schema.TaggedError<ClerkActionError>()(
	"@maple/web-foldkit/ClerkActionError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const stringField = (value: unknown, key: string): string | undefined =>
	Predicate.hasProperty(value, key) && typeof value[key] === "string" ? value[key] : undefined

/** `accountErrorMessage`: Clerk's own `longMessage`/`message`, else the error's, else `fallback`. */
export const clerkErrorMessage = (cause: unknown, fallback: string): string => {
	if (Predicate.hasProperty(cause, "errors") && Array.isArray(cause.errors)) {
		const first: unknown = cause.errors[0]
		return stringField(first, "longMessage") ?? stringField(first, "message") ?? fallback
	}
	return cause instanceof Error ? cause.message : fallback
}

const missing = (what: string) => new ClerkActionError({ message: `No ${what} is signed in`, cause: undefined })

/** The signed-in Clerk user (`useUser().user`). */
export const currentClerkUser: Effect.Effect<ClerkUserResource, ClerkActionError> = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(window.Clerk?.user), {
		onNone: () => Effect.fail(missing("user")),
		onSome: Effect.succeed,
	}),
)

/** The active organization (`useOrganization().organization`). */
export const currentClerkOrganization: Effect.Effect<ClerkOrganizationResource, ClerkActionError> =
	Effect.suspend(() =>
		Option.match(Option.fromNullishOr(window.Clerk?.organization), {
			onNone: () => Effect.fail(missing("organization")),
			onSome: Effect.succeed,
		}),
	)

/** The current session's id (`useSession().session?.id`). */
export const currentClerkSessionId: Effect.Effect<string | null> = Effect.sync(
	() => window.Clerk?.session?.id ?? null,
)

/** A Clerk call, failing with Clerk's message or `fallback` (what `settleClerk` toasts). */
export const clerkTry = <A>(fallback: string, run: () => Promise<A>): Effect.Effect<A, ClerkActionError> =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new ClerkActionError({ message: clerkErrorMessage(cause, fallback), cause }),
	})

/** `setActive({ organization })` then home: after leaving or deleting the active organization. */
export const switchAwayFrom = (orgId: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const clerk = window.Clerk
		if (clerk === undefined) return
		const user = clerk.user
		const memberships =
			user === null || user === undefined
				? []
				: yield* Effect.tryPromise(() => user.getOrganizationMemberships()).pipe(
						Effect.map((page) => page.data),
						Effect.orElseSucceed(() => []),
					)
		const next = memberships.find((membership) => membership.organization.id !== orgId)?.organization.id ?? null
		// A failed switch falls through to navigation; Clerk's session refreshes on next load.
		yield* Effect.tryPromise(() => clerk.setActive({ organization: next })).pipe(Effect.ignore)
	})

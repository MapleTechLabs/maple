import { clerkJsUrl, computeClerkCookieSuffix } from "@maple/domain/clerk-js-url"
import { Effect, Option, Queue, Schema, Stream } from "effect"

/**
 * Who the visitor is to Clerk, without `@clerk/clerk-react`. Most visitors never signed in, so
 * clerk-js loads only when Clerk's own `__client_uat` cookie (set on the registered domain, `0`
 * when signed out) says a session may exist; clerk-js then confirms it and names the user.
 */

const PUBLISHABLE_KEY = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? ""

export class ClerkSessionError extends Schema.TaggedError<ClerkSessionError>()(
	"@maple/landing/ClerkSessionError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

// `useAuth().isSignedIn`: an active (not pending) session and its user.
const Resources = Schema.Struct({
	session: Schema.NullishOr(Schema.Struct({ status: Schema.optional(Schema.String) })),
	user: Schema.NullishOr(Schema.Struct({ id: Schema.String })),
})
type ClerkResources = typeof Resources.Encoded

interface ClerkGlobal {
	readonly load: (options: Readonly<Record<string, unknown>>) => Promise<void>
	readonly addListener: (listener: (resources: ClerkResources) => void) => () => void
}

declare global {
	interface Window {
		Clerk?: ClerkGlobal
	}
}

/**
 * `__client_uat`, or this instance's `__client_uat_<suffix>`, above zero: a session may exist.
 * Another instance's cookie on the same domain (a PR preview) does not count.
 */
export const hasClerkSessionCookie = (cookie: string, suffix: string): boolean =>
	cookie.split(";").some((pair) => {
		const [name = "", value = ""] = pair.trim().split("=")
		return (
			(name === "__client_uat" || name === `__client_uat_${suffix}`) && Number.parseInt(value, 10) > 0
		)
	})

/** The signed-in user's id in what Clerk emits (decoded: `window.Clerk` is whatever loaded), or null. */
export const signedInUserId = (resources: ClerkResources): string | null =>
	Option.match(Schema.decodeUnknownOption(Resources)(resources), {
		onNone: () => null,
		onSome: ({ session, user }) =>
			session === null || session === undefined || session.status === "pending"
				? null
				: (user?.id ?? null),
	})

/** clerk-js from the instance's Frontend API, as `<ClerkProvider>` (and the dashboard) loads it. */
const injectClerkJs = (src: string) =>
	Effect.callback<void, ClerkSessionError>((resume) => {
		const script = document.createElement("script")
		script.src = src
		script.async = true
		script.crossOrigin = "anonymous"
		script.setAttribute("data-clerk-js-script", "true")
		script.setAttribute("data-clerk-publishable-key", PUBLISHABLE_KEY)
		script.addEventListener("load", () => resume(Effect.void))
		script.addEventListener("error", (cause) =>
			resume(Effect.fail(new ClerkSessionError({ message: "Couldn't load Clerk", cause }))),
		)
		document.head.appendChild(script)
		return Effect.sync(() => script.remove())
	})

const loadedClerk = Effect.gen(function* () {
	if (window.Clerk === undefined) {
		// A malformed key (not base64) fails here, typed, and the header stays signed out.
		const src = yield* Effect.try({
			try: () => clerkJsUrl(PUBLISHABLE_KEY),
			catch: (cause) => new ClerkSessionError({ message: "Malformed publishable key", cause }),
		})
		yield* injectClerkJs(src)
	}
	const clerk = yield* Effect.fromNullishOr(window.Clerk).pipe(
		Effect.mapError((cause) => new ClerkSessionError({ message: "window.Clerk is missing", cause })),
	)
	yield* Effect.tryPromise({
		try: () => clerk.load({}),
		catch: (cause) => new ClerkSessionError({ message: "Clerk failed to load", cause }),
	})
	return clerk
})

/**
 * The signed-in user id, `null` first (what `useAuth` reports before Clerk loads), then each
 * change Clerk reports. Nothing at all without a publishable key, as the React header did.
 */
export const watchSignedInUser: Stream.Stream<string | null> = Stream.suspend(() => {
	if (PUBLISHABLE_KEY === "") return Stream.empty
	const suffix = Effect.tryPromise({
		try: () => computeClerkCookieSuffix(PUBLISHABLE_KEY),
		catch: (cause) => new ClerkSessionError({ message: "Couldn't hash the publishable key", cause }),
	})
	const changes = Stream.unwrap(
		Effect.gen(function* () {
			if (!hasClerkSessionCookie(document.cookie, yield* suffix)) return Stream.empty
			return yield* Effect.map(loadedClerk, (clerk) =>
				Stream.callback<string | null>((queue) =>
					Effect.acquireRelease(
						Effect.sync(() =>
							clerk.addListener((resources) =>
								Queue.offerUnsafe(queue, signedInUserId(resources)),
							),
						),
						(unsubscribe) => Effect.sync(unsubscribe),
					).pipe(Effect.andThen(Effect.never)),
				),
			)
		}),
	).pipe(Stream.catch(() => Stream.empty))
	return Stream.concat(Stream.make(null), changes)
})

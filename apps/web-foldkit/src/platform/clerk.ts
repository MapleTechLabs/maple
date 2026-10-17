import { OrgId, UserId } from "@maple/domain"
import { purgeForeignClerkCookies } from "@maple/web/lib/services/common/clerk-cookie-guard"
import { Effect, Option, Queue, Schema, Stream } from "effect"

/** The slice of clerk-js this app reads. `window.Clerk` is what the parity harness stubs. */
interface ClerkResources {
	readonly user?: { readonly id: string } | null
	readonly session?: { readonly getToken: () => Promise<string | null> } | null
	readonly organization?: { readonly id: string } | null
}
interface ClerkGlobal extends ClerkResources {
	readonly load: (options: Readonly<Record<string, unknown>>) => Promise<void>
	readonly addListener: (listener: (resources: ClerkResources) => void) => () => void
	readonly mountSignIn: (element: HTMLDivElement, props: Readonly<Record<string, unknown>>) => void
	readonly unmountSignIn: (element: HTMLDivElement) => void
}
declare global {
	interface Window {
		Clerk?: ClerkGlobal
	}
}

export class ClerkLoadError extends Schema.TaggedError<ClerkLoadError>()(
	"@maple/web-foldkit/ClerkLoadError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** What the app reads from a Clerk session (`useAuth()` in apps/web). */
export const ClerkSnapshot = Schema.Struct({
	maybeUserId: Schema.Option(UserId),
	maybeOrgId: Schema.Option(OrgId),
})
export type ClerkSnapshot = typeof ClerkSnapshot.Type

const toSnapshot = (resources: ClerkResources): ClerkSnapshot => ({
	maybeUserId: Option.map(Option.fromNullishOr(resources.user?.id), UserId.make),
	maybeOrgId: Option.map(Option.fromNullishOr(resources.organization?.id), OrgId.make),
})

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ?? ""
const signInUrl = import.meta.env.VITE_CLERK_SIGN_IN_URL?.trim() || "/sign-in"
const signUpUrl = import.meta.env.VITE_CLERK_SIGN_UP_URL?.trim() || "/sign-up"

/** `pk_test_<base64(frontendApi$)>`: where @clerk/clerk-react loads clerk-js from. */
const clerkJsUrl = (key: string) =>
	`https://${atob(key.split("_").slice(2).join("_")).replace(/\$$/, "")}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`

const injectClerkJs = Effect.callback<void, ClerkLoadError>((resume) => {
	const script = document.createElement("script")
	script.src = clerkJsUrl(publishableKey)
	script.async = true
	script.crossOrigin = "anonymous"
	script.setAttribute("data-clerk-js-script", "true")
	script.setAttribute("data-clerk-publishable-key", publishableKey)
	script.addEventListener("load", () => resume(Effect.void))
	script.addEventListener("error", (cause) =>
		resume(Effect.fail(new ClerkLoadError({ message: "Failed to load Clerk", cause }))),
	)
	document.head.appendChild(script)
})

const currentClerk = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(window.Clerk), {
		onNone: () =>
			Effect.fail(new ClerkLoadError({ message: "window.Clerk is missing", cause: undefined })),
		onSome: Effect.succeed,
	}),
)

/** Loads clerk-js the way `<ClerkProvider>` does (unless a stub already sits on `window`). */
export const loadClerk: Effect.Effect<ClerkSnapshot, ClerkLoadError> = Effect.gen(function* () {
	yield* Effect.promise(() => purgeForeignClerkCookies(publishableKey))
	if (window.Clerk === undefined) {
		yield* injectClerkJs
	}
	const clerk = yield* currentClerk
	yield* Effect.tryPromise({
		try: () =>
			clerk.load({
				signInUrl,
				signUpUrl,
				signUpFallbackRedirectUrl: "/quick-start",
				afterSignOutUrl: signInUrl,
			}),
		catch: (cause) => new ClerkLoadError({ message: "Clerk failed to load", cause }),
	})
	return toSnapshot(clerk)
})

/** Every Clerk emit (session touch, org switch, sign-out), as snapshots. */
export const clerkSnapshots: Stream.Stream<ClerkSnapshot> = Stream.callback<ClerkSnapshot>((queue) =>
	Option.match(Option.fromNullishOr(window.Clerk), {
		onNone: () => Effect.void,
		onSome: (clerk) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					clerk.addListener((resources) => Queue.offerUnsafe(queue, toSnapshot(resources))),
				),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
	}),
)

/** The session JWT for API calls (`getToken()` in apps/web's ClerkAuthBridge). */
export const clerkSessionToken: Effect.Effect<Option.Option<string>> = Effect.tryPromise(
	() => window.Clerk?.session?.getToken() ?? Promise.resolve(null),
).pipe(Effect.map(Option.fromNullishOr), Effect.orElseSucceed(Option.none))

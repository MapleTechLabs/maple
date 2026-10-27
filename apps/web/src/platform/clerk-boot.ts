import { Duration, Effect, Fiber, Option, Schema } from "effect"
import { labEnabled, labPathOf } from "../lab/boot"
import { clerkAppearance, clerkLocalization } from "../lib/clerk-appearance"
import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import { purgeForeignClerkCookies } from "../lib/services/common/clerk-cookie-guard"
import type { ClerkGlobal } from "./clerk"
import { clerkJsUrl } from "./clerk-js-url"

export class ClerkLoadError extends Schema.TaggedError<ClerkLoadError>()("@maple/web/ClerkLoadError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/** A loaded clerk-js, and when its load started and ended (ms since navigation start). */
export interface BootedClerk {
	readonly clerk: ClerkGlobal
	readonly startedAtMs: number
	readonly readyAtMs: number
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ?? ""
const signInUrl = import.meta.env.VITE_CLERK_SIGN_IN_URL?.trim() || "/sign-in"
const signUpUrl = import.meta.env.VITE_CLERK_SIGN_UP_URL?.trim() || "/sign-up"

const injectClerkJs = Effect.callback<void, ClerkLoadError>((resume) => {
	const script = document.createElement("script")
	// The exact URL index.html preloads (vite.config.ts), so this runs the bytes already fetched.
	script.src = clerkJsUrl(publishableKey)
	script.async = true
	script.crossOrigin = "anonymous"
	script.setAttribute("data-clerk-js-script", "true")
	script.setAttribute("data-clerk-publishable-key", publishableKey)
	script.addEventListener("load", () => resume(Effect.void))
	script.addEventListener("error", (cause) =>
		resume(Effect.fail(new ClerkLoadError({ message: "Couldn't load Clerk", cause }))),
	)
	document.head.appendChild(script)
	// Interrupted (the load deadline): a later attempt injects its own tag.
	return Effect.sync(() => script.remove())
})

const currentClerk = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(window.Clerk), {
		onNone: () =>
			Effect.fail(new ClerkLoadError({ message: "window.Clerk is missing", cause: undefined })),
		onSome: Effect.succeed,
	}),
)

const CLERK_LOAD_TIMEOUT = Duration.seconds(20)

const sinceNavigationStart = Effect.sync(() => Math.round(performance.now()))

/** Loads clerk-js the way `<ClerkProvider>` does (unless a stub already sits on `window`). */
const loadClerkJs: Effect.Effect<BootedClerk, ClerkLoadError> = Effect.gen(function* () {
	const startedAtMs = yield* sinceNavigationStart
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
				// `<ClerkProvider appearance localization>`: every Clerk surface inherits these.
				appearance: clerkAppearance,
				localization: clerkLocalization,
			}),
		catch: (cause) => new ClerkLoadError({ message: "Clerk failed to load", cause }),
	})
	return { clerk, startedAtMs, readyAtMs: yield* sinceNavigationStart }
})

const timedOut = new ClerkLoadError({ message: "Clerk did not load in time", cause: undefined })

// index.html runs this module before the app's own bundle has downloaded and evaluated, so
// Clerk's script and Frontend API round trip overlap that work instead of following it.
const started = isClerkAuthEnabled && !(labEnabled && labPathOf(location.pathname) !== undefined)

const boot = started ? Option.some(Effect.runFork(loadClerkJs)) : Option.none()

/**
 * The load index.html started, or a fresh one where it did not (lab pages, self-hosted).
 * The deadline counts from when the app asks, so a slow bundle download does not use it up.
 * Without one, a stalled script or `clerk.load` keeps the boot splash up forever.
 */
export const bootedClerk: Effect.Effect<BootedClerk, ClerkLoadError> = Option.match(boot, {
	onNone: () =>
		loadClerkJs.pipe(
			Effect.timeoutOrElse({ duration: CLERK_LOAD_TIMEOUT, orElse: () => Effect.fail(timedOut) }),
		),
	onSome: (fiber) =>
		Fiber.join(fiber).pipe(
			Effect.timeoutOrElse({
				duration: CLERK_LOAD_TIMEOUT,
				// Interrupting the boot removes its script tag, as the old in-command deadline did.
				orElse: () => Effect.andThen(Fiber.interrupt(fiber), Effect.fail(timedOut)),
			}),
		),
})

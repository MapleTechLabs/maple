import { Duration, Effect, Fiber, Option, Ref, Schema } from "effect"
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

const bootFiber = Ref.makeUnsafe(Option.none<Fiber.Fiber<BootedClerk, ClerkLoadError>>())

/**
 * Called by `boot.ts`, index.html's first script: it runs before the app's own bundle has
 * downloaded and evaluated, so Clerk's script and Frontend API call overlap that work.
 */
export const startClerkBoot = (): void => {
	if (!isClerkAuthEnabled || (labEnabled && labPathOf(location.pathname) !== undefined)) return
	Effect.runSync(Ref.set(bootFiber, Option.some(Effect.runFork(loadClerkJs))))
}

const withDeadline = <A>(
	effect: Effect.Effect<A, ClerkLoadError>,
	onTimeout: Effect.Effect<void>,
): Effect.Effect<A, ClerkLoadError> =>
	Effect.timeoutOrElse(effect, {
		duration: CLERK_LOAD_TIMEOUT,
		orElse: () => Effect.andThen(onTimeout, Effect.fail(timedOut)),
	})

/**
 * The load `startClerkBoot` started, or a fresh one where it did not (lab pages, self-hosted).
 * The deadline counts from when the app asks, so a slow bundle download does not use it up.
 * Without one, a stalled script or `clerk.load` keeps the boot splash up forever.
 */
export const bootedClerk: Effect.Effect<BootedClerk, ClerkLoadError> = Effect.flatMap(
	Ref.get(bootFiber),
	Option.match({
		onNone: () => withDeadline(loadClerkJs, Effect.void),
		// Interrupting the boot removes its script tag, as the old in-command deadline did.
		onSome: (fiber) => withDeadline(Fiber.join(fiber), Fiber.interrupt(fiber)),
	}),
)

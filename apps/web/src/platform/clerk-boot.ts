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

/** A loaded clerk-js, and when its load finished (ms since navigation start). */
interface LoadedClerk {
	readonly clerk: ClerkGlobal
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
const loadClerkJs: Effect.Effect<LoadedClerk, ClerkLoadError> = Effect.gen(function* () {
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
	return { clerk, readyAtMs: yield* sinceNavigationStart }
})

const timedOut = new ClerkLoadError({ message: "Clerk did not load in time", cause: undefined })

interface Boot {
	readonly fiber: Fiber.Fiber<LoadedClerk, ClerkLoadError>
	readonly startedAtMs: number
}

const boot = Ref.makeUnsafe(Option.none<Boot>())

/**
 * Called by `boot.ts`, index.html's first script: it runs before the app's own bundle has
 * downloaded and evaluated, so Clerk's script and Frontend API call overlap that work.
 */
export const startClerkBoot = (): void => {
	if (!isClerkAuthEnabled || (labEnabled && labPathOf(location.pathname) !== undefined)) return
	const startedAtMs = Math.round(performance.now())
	Effect.runSync(Ref.set(boot, Option.some({ fiber: Effect.runFork(loadClerkJs), startedAtMs })))
}

const withDeadline = <A>(
	effect: Effect.Effect<A, ClerkLoadError>,
	onTimeout: Effect.Effect<void>,
): Effect.Effect<A, ClerkLoadError> =>
	Effect.timeoutOrElse(effect, {
		duration: CLERK_LOAD_TIMEOUT,
		orElse: () => Effect.andThen(onTimeout, Effect.fail(timedOut)),
	})

/** Boot timing on the current span (`LoadClerk`), whether the load succeeded or not. */
const annotated = (
	load: Effect.Effect<LoadedClerk, ClerkLoadError>,
	startedAtMs: number,
	bootedEarly: boolean,
): Effect.Effect<ClerkGlobal, ClerkLoadError> => {
	const annotate = (endMs: number) =>
		Effect.annotateCurrentSpan({
			"maple.clerk.load_start_ms": startedAtMs,
			"maple.clerk.load_end_ms": endMs,
			"maple.clerk.booted_early": bootedEarly,
		})
	return load.pipe(
		Effect.tap(({ readyAtMs }) => annotate(readyAtMs)),
		Effect.tapError(() => Effect.flatMap(sinceNavigationStart, annotate)),
		Effect.map(({ clerk }) => clerk),
	)
}

/**
 * The load `startClerkBoot` started, or a fresh one where it did not (lab pages, self-hosted).
 * The deadline counts from when the app asks, so a slow bundle download does not use it up.
 * Without one, a stalled script or `clerk.load` keeps the boot splash up forever.
 */
export const bootedClerk: Effect.Effect<ClerkGlobal, ClerkLoadError> = Effect.flatMap(
	Ref.get(boot),
	Option.match({
		onNone: () =>
			Effect.flatMap(sinceNavigationStart, (startedAtMs) =>
				annotated(withDeadline(loadClerkJs, Effect.void), startedAtMs, false),
			),
		// Interrupting the boot removes its script tag, as the old in-command deadline did.
		onSome: ({ fiber, startedAtMs }) =>
			annotated(withDeadline(Fiber.join(fiber), Fiber.interrupt(fiber)), startedAtMs, true),
	}),
)

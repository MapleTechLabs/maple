// `@maple-dev/browser/sveltekit`: navigations, load functions and client errors.
//
// SvelteKit reports a client-side navigation's start and end to the root
// layout (`beforeNavigate`, `afterNavigate`), but never the first load's
// start: the client `init` hook opens that one, before hydration runs the
// first page's load functions.
//
// The layout passes its `$app/navigation` and `$app/state` imports in. Those
// are virtual modules only SvelteKit's Vite plugin resolves, and Node can't
// import them from a package the server build leaves external. SvelteKit
// bundles a package only when it declares Svelte, for the whole package: the
// main entry would change for every SvelteKit app, not just this entry's.
import type { AfterNavigate, BeforeNavigate, HandleClientError, NavigationType } from "@sveltejs/kit"
import { isHttpError, isRedirect } from "@sveltejs/kit"
import { captureException } from "../errors"
import { endNavigation, startNavigation, traced } from "../navigation"

/** What `traceNavigation` needs from `$app/navigation` and `$app/state`. */
export interface SvelteKitNavigation {
	readonly beforeNavigate: (callback: (navigation: BeforeNavigate) => void) => void
	readonly afterNavigate: (callback: (navigation: AfterNavigate) => void) => void
	/** Read when a navigation is cancelled or overtaken, not when passed. */
	readonly navigating: { readonly type: NavigationType | null }
	readonly page: { readonly route: { readonly id: string | null } }
}

/** Export as `init` from `hooks.client.ts`: opens the page load span, which `traceNavigation` ends. */
export function startPageLoad(): void {
	startNavigation(location.pathname)
}

/**
 * Call in the root `+layout.svelte`'s script with the `$app/navigation` and `$app/state` imports:
 * a span per navigation, named after the route (`navigate /projects/[id]`).
 */
export function traceNavigation({
	beforeNavigate,
	afterNavigate,
	navigating,
	page,
}: SvelteKitNavigation): void {
	beforeNavigate((navigation) => {
		// Leaving the app loads a new document, with its own page load
		if (navigation.willUnload || !navigation.to) return
		startNavigation(navigation.to.url.pathname)
		// Rejects when the navigation is cancelled, or overtaken by a click or a
		// back while it loads, which don't call `beforeNavigate`: a newer navigation
		// still loading takes the span over, and names it when it ends
		navigation.complete.catch(() => {
			if (!navigating.type) endNavigation()
		})
	})
	// `navigation.to.route.id` is null on the first load; `page.route.id` is set
	afterNavigate(() => endNavigation(page.route.id ?? undefined))
}

// `redirect()` and `error()` below 500 are control flow, as for SvelteKit's own server spans
const isFailure = (error: unknown): boolean =>
	!isRedirect(error) && !(isHttpError(error) && error.status < 500)

/**
 * Run a universal `load` function's work in a span under the navigation, in the browser.
 * `redirect()` and `error()` below 500 aren't failures. On the server it only runs `fn`: SvelteKit spans it.
 */
export function loadSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
	return typeof window === "undefined" ? fn() : traced(name, fn, { isFailure })
}

/**
 * Wrap your client `handleError`, or create one: `export const handleError = handleErrorWithMaple()`.
 * Reports unexpected errors once, skipping 404s (unknown routes); what yours returns is kept.
 */
export function handleErrorWithMaple(handleError?: HandleClientError): HandleClientError {
	return (input) => {
		if (input.status !== 404) captureException(input.error, { name: "sveltekit.client_error" })
		return handleError?.(input)
	}
}

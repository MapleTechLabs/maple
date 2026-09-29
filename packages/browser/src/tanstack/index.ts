// `@maple-dev/browser/tanstack`: TanStack Router navigations, loaders and
// error boundaries.
//
// The router reports where a navigation starts (`onBeforeNavigate`) and ends
// (`onResolved`). Hydrating a TanStack Start page emits only `onRendered`, so
// the page load opens as soon as the router exists. With TanStack Start this
// module also runs on the server, where `traceRouter` does nothing and
// `tracedLoader` spans under the request.
import { type AnyRouter, isNotFound, isRedirect } from "@tanstack/react-router"
import { captureException } from "../errors"
import { endNavigation, interruptNavigation, startNavigation, traced } from "../navigation"
import { routeTemplate } from "./route"

/** Call right after creating the router, after `init()`: a span per navigation, named after its route (`navigate /projects/$id`). */
export function traceRouter(router: AnyRouter): void {
	// The router emits the same events while rendering on the server
	if (typeof window === "undefined") return
	// The page load, open until its route renders
	const first = router.latestLocation
	startNavigation(first.pathname)
	/** The navigation in flight, the page load first, and the history entry it loads in. */
	let pending: { readonly index: number | undefined } | undefined = { index: first.state.__TSR_index }

	router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
		const index: number | undefined = toLocation.state.__TSR_index
		// The navigation in flight loads its own history entry again: a client-only
		// app's first load, or a `redirect()` or TanStack Start fixing up the URL
		// it hydrated, both of which replace the entry. One span covers both.
		// Without the index, only the first load is recognized.
		if (index === undefined ? !fromLocation : index === pending?.index) return
		if (
			fromLocation &&
			toLocation.pathname === fromLocation.pathname &&
			toLocation.searchStr === fromLocation.searchStr
		) {
			// A hash link, `router.invalidate()` or a link to the route on screen
			// renders nothing new, and abandons a navigation still in flight
			if (pending) interruptNavigation()
			pending = undefined
			return
		}
		pending = { index }
		startNavigation(toLocation.pathname)
	})

	const end = () => {
		pending = undefined
		endNavigation(routeTemplate(router))
	}
	router.subscribe("onResolved", end)
	router.subscribe("onRendered", end)
}

/**
 * Run a loader or `beforeLoad` in a span under the navigation (on the server, under the request).
 * Errors are recorded once and rethrown; `redirect()` and `notFound()` aren't errors.
 */
export function tracedLoader<T>(name: string, fn: () => Promise<T>): Promise<T> {
	return traced(name, fn, { isFailure: (error) => !isRedirect(error) && !isNotFound(error) })
}

/**
 * Report what a route's error boundary caught: `defaultOnCatch: (error) => reportRouterError(router, error)`.
 * Skips loader errors, which `tracedLoader` recorded on the loader's span.
 */
export function reportRouterError(router: AnyRouter, error: unknown): void {
	// A loader that failed during server rendering: the server recorded it, and
	// the browser only has a copy, which `captureException` can't recognize
	if (router.state.matches.some((match) => match.error === error)) return
	captureException(error, { name: "react.render_error" })
}

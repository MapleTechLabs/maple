// `@maple-dev/browser/react-router`: navigations, loaders, actions and route errors.
//
// React Router's instrumentation API wraps every loader and action, and says
// when a navigation starts. Where it ends depends on the mode: data mode
// subscribes to the router the app created, framework mode ends each click in
// the `navigate` hook, and its page load in the root `Layout` once the page
// hydrates.
//
// `root.tsx` renders on the server too: nothing here touches `window` on import.
// An effect is the only signal that the page hydrated
// oxlint-disable-next-line maple/no-react-use-effect
import { useEffect } from "react"
import {
	type ClientInstrumentation,
	type ClientOnErrorFunction,
	type DataRouter,
	isRouteErrorResponse,
	useMatches,
} from "react-router"
import { captureException } from "../errors"
import { endNavigation, interruptNavigation, startNavigation, traced } from "../navigation"
import { matchedPattern, routePattern, traceRouteHandlers } from "./route"

/**
 * A server loader's or action's error as production React Router hands it to
 * the browser: its message replaced, its stack dropped. The server's span
 * recorded the real one.
 */
const fromServer = (error: unknown): boolean =>
	error instanceof Error && error.message === "Unexpected Server Error" && error.stack === undefined

const traceHandlers = traceRouteHandlers((name, fn) =>
	traced(name, fn, { isFailure: (error) => !fromServer(error) }),
)

/** Pass to `createBrowserRouter`'s `instrumentations` (data mode), then call `traceNavigations(router)`. */
export const dataRouterInstrumentation: ClientInstrumentation = {
	// Runs when the router is created, before the first route's loaders
	router: () => startNavigation(window.location.pathname),
	route: traceHandlers,
}

/** Call right after `createBrowserRouter` (data mode): ends each navigation span, named after its route pattern. */
export function traceNavigations(router: DataRouter): () => void {
	const pattern = (state: DataRouter["state"]) =>
		matchedPattern(state.matches.map((match) => match.route.path))
	// The first route's loaders may still be running
	let loading = !router.state.initialized
	let pathname = router.state.location.pathname
	if (!loading) endNavigation(pattern(router.state))

	return router.subscribe((state) => {
		if (state.navigation.state !== "idle") {
			// A redirect or a second click while loading continues the same span
			if (!loading) startNavigation(state.navigation.location.pathname)
			loading = true
			return
		}
		// The first load leaves the navigation state idle: it ends once the router is initialized
		if (!state.initialized) return
		// Fetcher loads, revalidations and hash changes aren't navigations
		if (!loading && state.location.pathname === pathname) return
		// A route without loaders goes straight to the new location
		if (!loading) startNavigation(state.location.pathname)
		endNavigation(pattern(state))
		loading = false
		pathname = state.location.pathname
	})
}

/** Route ids to their paths, for `useMaplePageload`: `useMatches()` only has the ids. */
const routePaths = new Map<string, string | undefined>()
/** Counts clicks and history navigations: only the latest click ends its span. */
let latest = 0
/** Whether the page load is still open for `useMaplePageload` to end. */
let pageLoading = false

/** Pass to `HydratedRouter`'s `instrumentations` (framework mode), with `useMaplePageload()` in the root `Layout`. */
export const frameworkInstrumentation: ClientInstrumentation = {
	router({ instrument }) {
		startNavigation(window.location.pathname)
		pageLoading = true
		// Back and forward don't go through `navigate`, and abandon a click still loading
		window.addEventListener("popstate", () => {
			latest++
			interruptNavigation()
		})
		instrument({
			navigate: async (navigate, { to }) => {
				// `navigate(-1)` is a history navigation, like the back button, and hash links run nothing
				if (typeof to === "number" || to.startsWith("#")) return
				const id = ++latest
				// `to` can carry a query string, or be relative. React Router resolves a
				// relative one against the route, this against the URL: only `url.path` can differ.
				startNavigation(new URL(to, window.location.href).pathname)
				// `meta` since React Router 8.1
				const { meta } = await navigate()
				// A newer navigation has already replaced this one
				if (id === latest) endNavigation(meta && routePattern(meta.pattern))
			},
		})
	},
	route(route) {
		routePaths.set(route.id, route.path)
		traceHandlers(route)
	},
}

/**
 * Call in the root route's `Layout` (framework mode): ends the page load span once the page hydrates.
 * `Layout` also wraps the root `ErrorBoundary`, so 404 and error pages end it too.
 */
export function useMaplePageload(): void {
	const matches = useMatches()
	// The server already ran the loaders: the page is ready once it hydrates. The
	// page, its error boundary and its hydrate fallback each mount a `Layout` of
	// their own: only the first ends the page load.
	useEffect(() => {
		if (!pageLoading) return
		pageLoading = false
		endNavigation(matchedPattern(matches.map((match) => routePaths.get(match.id))))
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [])
}

/** Pass as `onError` to `RouterProvider` or `HydratedRouter`: reports render, loader and action errors once each. */
export const reportRouteError: ClientOnErrorFunction = (error, { pattern }) => {
	// Thrown responses, like a loader's 404, are expected
	if (isRouteErrorResponse(error) || fromServer(error)) return
	// A loader or action error is already on its span, and `captureException` skips it
	captureException(error, {
		name: "react_router.error",
		attributes: { "app.route": routePattern(pattern) },
	})
}

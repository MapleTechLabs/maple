"use client"
// `@maple-dev/browser/nextjs`: App Router navigations and error boundaries.
//
// Next.js reports where a navigation starts (`onRouterTransitionStart` in
// `instrumentation-client.ts`) but not where it ends. That comes from React: a
// component in the root layout ends the span in an effect, which runs once the
// new route is committed. Both halves share `committed`.
//
// "use client": the root layout, a Server Component, renders `MapleNavigation`.
import { useParams, usePathname, useSearchParams, useSelectedLayoutSegments } from "next/navigation"
// An effect is the only signal that a route committed
// oxlint-disable-next-line maple/no-react-use-effect
import { createElement, type ReactElement, Suspense, useEffect } from "react"
import { captureException } from "../errors"
import { endNavigation, interruptNavigation, startNavigation } from "../navigation"
import { routeTemplate, urlKey } from "./route"

/** Pathname and query of the route React last committed. */
let committed: string | undefined

/** Re-export from `instrumentation-client.ts`: starts a span for each App Router navigation. */
export function onRouterTransitionStart(url: string): void {
	const target = new URL(url, location.href)
	// Hash-only changes and links to the current URL don't render a new route, and
	// the effect that ends a navigation won't run: one still in flight, like a
	// click away and straight back, is abandoned
	if (urlKey(target.pathname, target.search) === committed) interruptNavigation()
	else startNavigation(target.pathname)
}

function NavigationEnd(): null {
	const pathname = usePathname()
	const search = useSearchParams().toString()
	const params = useParams()
	// URLs no route matches render Next.js's built-in `/_not-found` route: without
	// this, every mistyped URL would become its own span name
	const route =
		useSelectedLayoutSegments()[0] === "/_not-found" ? "/_not-found" : routeTemplate(pathname, params)

	// The commit is the signal itself: effects run once the new route is on screen.
	// Keyed on strings: `useParams()` returns a new object when the same route
	// commits again (`router.refresh()`, a server action revalidating), which must
	// not end a navigation to another route still in flight.
	useEffect(() => {
		committed = urlKey(pathname, search)
		endNavigation(route)
	}, [pathname, search, route])

	return null
}

/** Render once in the root layout, above `{children}`: ends each navigation span, named after its route. */
export function MapleNavigation(): ReactElement {
	// `useSearchParams()` outside a Suspense boundary fails the build of a statically rendered page
	return createElement(Suspense, null, createElement(NavigationEnd))
}

/**
 * Report the error an `error.tsx` or `global-error.tsx` boundary caught, from an effect.
 * Skips server errors (those with a `digest`), which Next.js already recorded on its server span.
 */
export function reportNextError(error: unknown): void {
	// In production a Server Component's error reaches the browser with its
	// message stripped and a `digest` added: one meaningless issue for all of them
	if (typeof error === "object" && error !== null && "digest" in error && error.digest) return
	captureException(error, { name: "react.render_error" })
}

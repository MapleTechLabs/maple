import { type AnyRouter, rootRouteId } from "@tanstack/react-router"

/**
 * The matched route's template: `/projects/$id`. `fullPath`, not `routeId`,
 * which also names pathless layouts and route groups. A URL no route handles
 * is `not-found`, not the root or layout route that renders the not-found page.
 */
export function routeTemplate(router: AnyRouter): string | undefined {
	const matches = router.state.matches
	const leaf = matches.at(-1)
	// Only the root matched, or a layout did and the rest of the URL matched nothing
	if (leaf?.routeId === rootRouteId || matches.some((match) => match._notFound)) return "not-found"
	return leaf?.fullPath
}

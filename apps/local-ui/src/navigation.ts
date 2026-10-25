import { Option } from "effect"
import type { Url } from "foldkit/url"
import { parseLocation, parseRoute, type AppRoute, type Location } from "./route"

/** The fragment of a Foldkit `Url`, without its `#`. */
export const hashOf = (url: Url): string => Option.getOrElse(url.hash, () => "")

export const locationOf = (url: Url): Location => parseLocation(hashOf(url))

export const routeOf = (location: Location): AppRoute => parseRoute(location.path)

/**
 * `trackHashChange` (lib/router.ts): a replace rewrites the last entry, a return to the previous
 * hash pops it (Back), anything else is a new entry.
 */
export const trackVisit = (
	visited: ReadonlyArray<string>,
	hash: string,
	isReplacing: boolean,
): ReadonlyArray<string> => {
	if (isReplacing) return [...visited.slice(0, -1), hash]
	if (visited.length > 1 && visited[visited.length - 2] === hash) return visited.slice(0, -1)
	return [...visited, hash]
}

/** `canGoBackInApp`: the previous history entry is a page of this app. */
export const canGoBack = (visited: ReadonlyArray<string>): boolean => visited.length > 1

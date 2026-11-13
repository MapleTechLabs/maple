import { Option, String as Str } from "effect"
/** Same-origin path to the API, so browser calls skip the CORS preflight. */
export const API_PROXY_PREFIX = "/_api"

/** The API's reference pages run a third-party viewer script, so they stay on the API's own origin. */
const NOT_PROXIED = new Set(["/docs", "/v2/docs"])

const decodePath = Option.liftThrowable(decodeURI)

/** The path as the API's router matches it: anything from a `;` dropped, escapes decoded, no trailing slash. */
const routedPath = (path: string): string => {
	const raw = Str.replace(/;.*$/, "")(path)
	// A malformed escape decodes to nothing the router could match either.
	return Str.replace(/\/+$/, "")(Option.getOrElse(decodePath(raw), () => raw))
}

export const apiProxyPath = (pathname: string): string | undefined => {
	if (pathname === API_PROXY_PREFIX) return "/"
	if (!Str.startsWith(`${API_PROXY_PREFIX}/`)(pathname)) return undefined
	const path = Str.slice(API_PROXY_PREFIX.length)(pathname)
	return NOT_PROXIED.has(routedPath(path)) ? undefined : path
}

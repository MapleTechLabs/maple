import { String as Str } from "effect"
/** Same-origin path to the API, so browser calls skip the CORS preflight. */
export const API_PROXY_PREFIX = "/_api"

/** The API's reference pages run a third-party viewer script, so they stay on the API's own origin. */
const NOT_PROXIED = new Set(["/docs", "/v2/docs"])

export const apiProxyPath = (pathname: string): string | undefined => {
	if (pathname === API_PROXY_PREFIX) return "/"
	if (!Str.startsWith(`${API_PROXY_PREFIX}/`)(pathname)) return undefined
	const path = Str.slice(API_PROXY_PREFIX.length)(pathname)
	return NOT_PROXIED.has(Str.replace(/\/+$/, "")(path)) ? undefined : path
}

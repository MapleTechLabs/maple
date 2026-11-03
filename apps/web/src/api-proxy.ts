import { String as Str } from "effect"
/** Same-origin path to the API, so browser calls skip the CORS preflight. */
export const API_PROXY_PREFIX = "/_api"

export const apiProxyPath = (pathname: string): string | undefined => {
	if (pathname === API_PROXY_PREFIX) return "/"
	return Str.startsWith(`${API_PROXY_PREFIX}/`)(pathname)
		? Str.slice(API_PROXY_PREFIX.length)(pathname)
		: undefined
}

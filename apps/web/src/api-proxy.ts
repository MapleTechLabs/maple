/**
 * Same-origin path to the API. A browser call to another origin that carries
 * `Authorization` waits on a CORS preflight, cached per exact URL, so a
 * dashboard firing many distinct queries paid one round trip on most calls.
 * Under this prefix the call is same-origin and the browser sends none.
 */
export const API_PROXY_PREFIX = "/_api"

/** The API path a proxied request is for, or undefined when it is not proxied. */
export const apiProxyPath = (pathname: string): string | undefined => {
	if (pathname === API_PROXY_PREFIX) return "/"
	return pathname.startsWith(`${API_PROXY_PREFIX}/`) ? pathname.slice(API_PROXY_PREFIX.length) : undefined
}

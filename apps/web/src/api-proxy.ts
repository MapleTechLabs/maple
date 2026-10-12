/** Same-origin path to the API, so browser calls skip the CORS preflight. */
export const API_PROXY_PREFIX = "/_api"

export const apiProxyPath = (pathname: string): string | undefined => {
	if (pathname === API_PROXY_PREFIX) return "/"
	return pathname.startsWith(`${API_PROXY_PREFIX}/`) ? pathname.slice(API_PROXY_PREFIX.length) : undefined
}

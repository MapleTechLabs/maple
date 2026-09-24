import { defaultParseSearch } from "@tanstack/react-router"

/**
 * Split an app-relative href (`/settings?tab=mcp`) into the `to` + `search` pair a typed
 * `<Link>` wants. Shared by the breadcrumb trail and any server-provided link.
 */
export function parseSearchFromHref(href: string): { pathname: string; search?: Record<string, unknown> } {
	const [pathname = "/", queryString] = href.split("?")
	if (!queryString) {
		return { pathname }
	}
	return { pathname, search: defaultParseSearch(queryString) as Record<string, unknown> }
}

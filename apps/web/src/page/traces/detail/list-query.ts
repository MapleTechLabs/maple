// The list filters riding on the trace page's URL, for the way back to /traces:
// everything but the page's own `spanId`, `t` and `view`, kept verbatim.

const OWN_PARAMS = ["spanId", "t", "view"]

/** `buildBackToTracesHref`'s params: the URL's query without the page's own. */
export const listQueryOf = (search: string): string => {
	const params = new URLSearchParams(search)
	OWN_PARAMS.forEach((name) => params.delete(name))
	return params.toString()
}

/** The "Traces" crumb and the not-found back links. */
export const backToTracesHref = (listQuery: string): string =>
	listQuery === "" ? "/traces" : `/traces?${listQuery}`

/** A trace page href that keeps the list's params (`search: (prev) => ({ ...prev, ... })`). */
export const withListQuery = (href: string, listQuery: string): string => {
	if (listQuery === "") return href
	const [path = href, own = ""] = href.split("?")
	return own === "" ? `${path}?${listQuery}` : `${path}?${listQuery}&${own}`
}

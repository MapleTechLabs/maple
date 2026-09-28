/** A route's dynamic params, as `useParams()` returns them. */
type RouteParams = Readonly<Record<string, string | readonly string[] | undefined>>

/** Pathname and query: what renders a route. The hash doesn't. */
export const urlKey = (pathname: string, search: string): string =>
	`${pathname}?${new URLSearchParams(search)}`

/**
 * The App Router's route for `pathname`: `/projects/8f2a` with `{ id: "8f2a" }`
 * becomes `/projects/[id]`, `/docs/a/b` with `{ slug: ["a", "b"] }` becomes
 * `/docs/[...slug]`. Next.js doesn't expose the matched route on the client, so
 * it is rebuilt from the params.
 */
export function routeTemplate(pathname: string, params: RouteParams): string {
	const segments = pathname.split("/")
	let end = segments.length
	// Params are ordered from the root. Matching from the end keeps a static
	// segment that happens to equal a param value, like in `/projects/projects`.
	for (const [name, value] of Object.entries(params).reverse()) {
		// An optional catch-all without segments has nothing to replace
		if (!value?.length) continue
		const parts: readonly string[] = typeof value === "string" ? [value] : value
		const matchesAt = (at: number) =>
			parts.every(
				(part, i) => segments[at + i] === part || segments[at + i] === encodeURIComponent(part),
			)
		let at = end - parts.length
		while (at > 0 && !matchesAt(at)) at--
		// Index 0 is the empty segment before the leading `/`
		if (at <= 0) continue
		segments.splice(at, parts.length, typeof value === "string" ? `[${name}]` : `[...${name}]`)
		end = at
	}
	return segments.join("/")
}

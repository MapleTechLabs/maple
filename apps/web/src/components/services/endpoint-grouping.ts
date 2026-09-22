// Endpoint path grouping
//
// The API tab groups endpoints by their shared path stem so the stem is printed
// once as a header and rows carry only their leaf. That exists because the route
// is the row's identity and the only variable-width element in it: in a flat
// table the numeric columns hold their width and the route absorbs every pixel
// of the squeeze, so `/v2/organizations/{orgId}/dashboards/{id}/widgets` is the
// thing that gets truncated. Grouping removes the long half of the path from the
// row entirely rather than shrinking the font or clipping.
//
// Two rules keep it from making things worse:
//
//   1. A stem must cover at least TWO endpoints to become a header. A group of
//      one is strictly worse than no group — it costs a header row and saves
//      nothing.
//   2. The stem is the LONGEST common prefix, found by descending until the path
//      actually branches. `/v2/organizations` would be a legal stem for the
//      subscriptions endpoints and a useless one; the reader wants
//      `/v2/organizations/{orgId}/subscriptions`.
//
// A service whose routes share no stem (`/healthz`, `/graphql`, `/metrics`)
// therefore produces no headers at all and degrades into a plain sorted list.

import type { ServiceEndpoint } from "@/api/warehouse/service-endpoints"

export type EndpointGroupKind = "stem" | "ungrouped" | "unrouted" | "probes"

export interface EndpointGroup {
	kind: EndpointGroupKind
	/** Shared path prefix, printed once as the header. Empty for non-stem groups. */
	stem: string
	endpoints: ServiceEndpoint[]
	totals: {
		estimatedSpanCount: number
		errorRate: number
		/** Worst percentiles in the group — percentiles do not average. */
		p50DurationMs: number
		p95DurationMs: number
		p99DurationMs: number
	}
}

export type EndpointSort = "traffic" | "path" | "errorRate" | "p50" | "p95" | "p99"
export type EndpointSortDir = "asc" | "desc"

const segments = (route: string): string[] => route.split("/").filter((part) => part.length > 0)

/**
 * Whether a route looks like a raw URL path rather than a route template.
 *
 * We cannot know this for certain from the rollup: it stores the already
 * normalized name, which prefers `http.route` and silently falls back to
 * `url.path`, and both arrive here as the same string. So this is a read of the
 * text, not a fact from the data — a segment that looks like an identifier means
 * the span almost certainly had no `http.route`, and its siblings are 1,200 more
 * rows of the same shape. Grouping them under one collapsed "unrouted" row is
 * the difference between a usable list and an unusable one; being occasionally
 * wrong about one route is cheap by comparison.
 */
export function looksUnrouted(route: string): boolean {
	return segments(route).some((segment) => {
		// Template segments are proof of the opposite — a real route.
		if (segment.startsWith("{") || segment.startsWith(":")) return false
		if (/^\d+$/.test(segment)) return true
		if (/^[0-9a-fA-F]{8,}$/.test(segment)) return true
		if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment))
			return true
		// Long opaque tokens (session ids, signed blobs).
		return segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment)
	})
}

/**
 * Bait paths that only ever appear when something is scanning you: CMS admin
 * panels on a service that is not a CMS, credential and config files, path
 * traversal, and proxy probes. A request for these never matched a route, so the
 * span carried `url.path` and became an "endpoint" indistinguishable from a real
 * one.
 *
 * Deliberately NOT here: `.well-known` (ACME, security.txt), `actuator` (Spring
 * Boot), `.json`, `.xml` — all legitimately served by real APIs. A false positive
 * hides a real endpoint, which is far worse than letting one probe through, so
 * the list stays narrow and everything it catches is still one click from view.
 */
const PROBE_EXTENSIONS =
	/\.(php\d?|phtml|asp|aspx|jsp|cgi|pl|sh|bak|old|swp|sql|env|ini|conf|cfg|pem|key|zip|tar|gz|tgz|rar|7z)$/i

const PROBE_FRAGMENTS = [
	"wp-admin",
	"wp-login",
	"wp-content",
	"wp-includes",
	"wp-config",
	"xmlrpc",
	"phpmyadmin",
	"phpunit",
	"cgi-bin",
	"/.git",
	"/.env",
	"/.aws",
	"/.ssh",
	"/.vscode",
	"/.idea",
	"/.svn",
	"/.docker",
	"eval-stdin",
	"shellshock",
	"hudson",
	"boaform",
	"webdav",
	"owa/auth",
	"telerik",
	"struts",
]

/**
 * Whether a route reads as scanner traffic rather than an endpoint this service
 * actually serves.
 *
 * Like {@link looksUnrouted} this is a read of the text, not a fact from the
 * data — see the note there. The real discriminator is whether the span carried
 * `http.route` at all, and the rollup does not keep it.
 */
export function looksLikeProbe(route: string): boolean {
	const lower = route.toLowerCase()
	// Proxy probes send an absolute URL as the request target.
	if (lower.startsWith("http://") || lower.startsWith("https://")) return true
	// Traversal and null-byte attempts, raw or percent-encoded.
	if (lower.includes("..") || lower.includes("%2e") || lower.includes("%00")) return true
	if (lower.includes("\\") || lower.includes("<") || lower.includes(">")) return true
	if (PROBE_EXTENSIONS.test(lower)) return true
	return PROBE_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

interface TrieNode {
	segment: string
	children: Map<string, TrieNode>
	/** Endpoints whose route ends exactly here. */
	terminal: ServiceEndpoint[]
	/** Endpoints at or below this node. */
	count: number
}

const emptyNode = (segment: string): TrieNode => ({
	segment,
	children: new Map(),
	terminal: [],
	count: 0,
})

function buildTrie(endpoints: readonly ServiceEndpoint[]): TrieNode {
	const root = emptyNode("")
	for (const endpoint of endpoints) {
		let node = root
		node.count += 1
		for (const segment of segments(endpoint.route)) {
			const next = node.children.get(segment) ?? emptyNode(segment)
			node.children.set(segment, next)
			next.count += 1
			node = next
		}
		node.terminal.push(endpoint)
	}
	return root
}

function subtreeEndpoints(node: TrieNode): ServiceEndpoint[] {
	const out = [...node.terminal]
	for (const child of node.children.values()) out.push(...subtreeEndpoints(child))
	return out
}

function totalsFor(endpoints: readonly ServiceEndpoint[]): EndpointGroup["totals"] {
	const estimatedSpanCount = endpoints.reduce((sum, e) => sum + e.estimatedSpanCount, 0)
	const estimatedErrorCount = endpoints.reduce((sum, e) => sum + e.estimatedErrorCount, 0)
	return {
		estimatedSpanCount,
		errorRate: estimatedSpanCount > 0 ? estimatedErrorCount / estimatedSpanCount : 0,
		p50DurationMs: endpoints.reduce((worst, e) => Math.max(worst, e.p50DurationMs), 0),
		p95DurationMs: endpoints.reduce((worst, e) => Math.max(worst, e.p95DurationMs), 0),
		p99DurationMs: endpoints.reduce((worst, e) => Math.max(worst, e.p99DurationMs), 0),
	}
}

function collect(node: TrieNode, path: string[], groups: EndpointGroup[], loose: ServiceEndpoint[]) {
	const emit = () => {
		const endpoints = subtreeEndpoints(node)
		groups.push({
			kind: "stem",
			stem: `/${path.join("/")}`,
			endpoints,
			totals: totalsFor(endpoints),
		})
	}

	// Too small to earn a header — a group of one costs a row and saves nothing.
	// It still becomes a group below, just a headerless one.
	if (node.count < 2) {
		loose.push(...subtreeEndpoints(node))
		return
	}
	// An endpoint terminates exactly here, so this node IS the longest prefix
	// every endpoint below shares. Descending would strand the index endpoint
	// (`/subscriptions`) in the ungrouped run, away from its own children.
	if (node.terminal.length > 0) {
		emit()
		return
	}
	// A single non-terminal child is just more shared prefix; keep descending so
	// the header prints `/v2/organizations/{orgId}/subscriptions`, not `/v2`.
	if (node.children.size === 1) {
		const [only] = [...node.children.values()]
		if (only !== undefined) {
			collect(only, [...path, only.segment], groups, loose)
			return
		}
	}
	// A branch where at least one side is itself groupable: split, and let the
	// thin branches fall through to the ungrouped run rather than being dragged
	// under a stem they do not belong to. Without this test, `/v2/webhooks` (2)
	// beside `/v2/status` (1) collapsed into one meaningless `/v2` group.
	if ([...node.children.values()].some((child) => child.count >= 2)) {
		for (const child of node.children.values()) {
			collect(child, [...path, child.segment], groups, loose)
		}
		return
	}
	// A branch whose children are all singletons — this node is the stem.
	emit()
}

const leafMetric = (endpoint: ServiceEndpoint, sort: Exclude<EndpointSort, "path">): number => {
	switch (sort) {
		case "traffic":
			return endpoint.estimatedSpanCount
		case "errorRate":
			return endpoint.errorRate
		case "p50":
			return endpoint.p50DurationMs
		case "p95":
			return endpoint.p95DurationMs
		case "p99":
			return endpoint.p99DurationMs
	}
}

const groupMetric = (group: EndpointGroup, sort: Exclude<EndpointSort, "path">): number => {
	switch (sort) {
		case "traffic":
			return group.totals.estimatedSpanCount
		case "errorRate":
			return group.totals.errorRate
		case "p50":
			return group.totals.p50DurationMs
		case "p95":
			return group.totals.p95DurationMs
		case "p99":
			return group.totals.p99DurationMs
	}
}

const byPath = (a: ServiceEndpoint, b: ServiceEndpoint) =>
	a.route.localeCompare(b.route) || a.method.localeCompare(b.method)

/**
 * Partition endpoints into stem groups, headerless singletons for the endpoints
 * no stem claimed, and the collapsed unrouted and probe buckets. Groups order by
 * their totals under the same key as their leaves — sorting by error rate puts
 * the worst group first and the worst endpoint first inside it. The collapsed
 * buckets stay pinned to the end whatever the sort; they are not endpoints
 * competing for the top of the list.
 */
export function groupEndpoints(
	endpoints: readonly ServiceEndpoint[],
	sort: EndpointSort = "traffic",
	dir: EndpointSortDir = sort === "path" ? "asc" : "desc",
): EndpointGroup[] {
	const probes: ServiceEndpoint[] = []
	const unrouted: ServiceEndpoint[] = []
	const routed: ServiceEndpoint[] = []
	for (const endpoint of endpoints) {
		// Probe first: `/wp-login.php` carries no identifier-shaped segment, so
		// the unrouted check waves it through as a normal endpoint.
		if (looksLikeProbe(endpoint.route)) probes.push(endpoint)
		else if (looksUnrouted(endpoint.route)) unrouted.push(endpoint)
		else routed.push(endpoint)
	}

	const groups: EndpointGroup[] = []
	const loose: ServiceEndpoint[] = []
	const root = buildTrie(routed)
	for (const child of root.children.values()) {
		collect(child, [child.segment], groups, loose)
	}
	// Endpoints whose route is "/" land on the root itself.
	loose.push(...root.terminal)

	// A loose endpoint is a group of one without a header. It competes with the
	// stem groups on its own numbers, so sorting by traffic puts a 40 req/s
	// `POST /query` above a 27 req/s dashboards group instead of below every
	// group on the page.
	for (const endpoint of loose) {
		groups.push({ kind: "ungrouped", stem: "", endpoints: [endpoint], totals: totalsFor([endpoint]) })
	}

	const sign = dir === "asc" ? 1 : -1
	const leafSort =
		sort === "path"
			? (a: ServiceEndpoint, b: ServiceEndpoint) => sign * byPath(a, b)
			: (a: ServiceEndpoint, b: ServiceEndpoint) => sign * (leafMetric(a, sort) - leafMetric(b, sort))
	for (const group of groups) group.endpoints.sort(leafSort)

	const groupPath = (group: EndpointGroup) => group.stem || (group.endpoints[0]?.route ?? "")
	groups.sort(
		sort === "path"
			? (a, b) => sign * groupPath(a).localeCompare(groupPath(b))
			: (a, b) => sign * (groupMetric(a, sort) - groupMetric(b, sort)),
	)

	if (unrouted.length > 0) {
		groups.push({
			kind: "unrouted",
			stem: "",
			endpoints: unrouted.sort(leafSort),
			totals: totalsFor(unrouted),
		})
	}
	if (probes.length > 0) {
		groups.push({
			kind: "probes",
			stem: "",
			endpoints: probes.sort(leafSort),
			totals: totalsFor(probes),
		})
	}
	return groups
}

export interface LeafLabel {
	/** Everything between the stem and the final segment, dimmed. */
	head: string
	/** The final segment — the part that identifies this endpoint. */
	tail: string
}

/**
 * Split a route into the muted remainder and the segment that actually
 * distinguishes it from its siblings. An endpoint that IS the stem has no
 * remainder and reads as "(index)". Without a stem the route is printed whole:
 * the head is its parent path and the tail its last segment, so the root
 * route stays "/" rather than an index of nothing.
 */
export function leafLabel(route: string, stem: string): LeafLabel {
	const grouped = stem.length > 0 && route.startsWith(stem)
	const remainder = grouped ? route.slice(stem.length) : route
	if (remainder === "" || remainder === "/") {
		return grouped ? { head: "", tail: "(index)" } : { head: "", tail: "/" }
	}
	const lastSlash = remainder.lastIndexOf("/")
	if (lastSlash <= 0) return { head: "", tail: remainder }
	const head = remainder.slice(0, lastSlash)
	return { head: grouped ? `…${head}` : head, tail: remainder.slice(lastSlash) }
}

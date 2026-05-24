import { Option } from "effect"
import { Headers, HttpServerRequest } from "effect/unstable/http"

// Resolves the request's origin (scheme + host) honoring `x-forwarded-*`
// headers — Cloudflare and most proxies set these on the inbound request.
// Falls back to parsing `req.url` (absolute under wrangler/CF Workers), then
// to an empty string if neither path yields anything useful.
//
// Used by route handlers that need to build callback URLs back to the same
// origin the request arrived on (OAuth start, GitHub App install, etc.).
// Returns true if `candidate` resolves to the same origin as `origin` —
// guards against open-redirects when a handler stores a caller-supplied URL
// and later navigates the browser to it (e.g. OAuth `returnTo`). A relative
// path is always treated as same-origin since it inherits `origin`.
export const isSameOrigin = (origin: string, candidate: string): boolean => {
	try {
		const candidateUrl = new URL(candidate, origin)
		const originUrl = new URL(origin)
		return candidateUrl.origin === originUrl.origin
	} catch {
		return false
	}
}

export const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
	const forwardedHost = Option.getOrUndefined(Headers.get(req.headers, "x-forwarded-host"))
	const forwardedProto = Option.getOrUndefined(Headers.get(req.headers, "x-forwarded-proto"))
	const host = forwardedHost ?? Option.getOrUndefined(Headers.get(req.headers, "host"))
	if (host) {
		const proto =
			forwardedProto ??
			(host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
		return `${proto}://${host}`
	}
	try {
		const parsed = new URL(req.url)
		return `${parsed.protocol}//${parsed.host}`
	} catch {
		return ""
	}
}

/**
 * URL redaction for everything that leaves the page carrying a URL: session
 * entry/exit URLs, event rows, network events, rrweb meta events and span
 * attributes.
 *
 * Magic links, password resets and OAuth implicit flows put credentials in the
 * query string or fragment, and a page view is captured on exactly those
 * pages. Values of credential-shaped parameters are therefore replaced by
 * default; the host app can add its own `sanitizeUrl` on top.
 */

export type UrlSanitizer = (url: string) => string

const REDACTED = "REDACTED"

const SENSITIVE_PARAM =
	/^(access_token|id_token|refresh_token|token|auth|authorization|code|state|password|passwd|pwd|pass|secret|client_secret|api_key|apikey|key|signature|sig|otp|jwt|session|sessionid|session_id|ticket|__clerk_ticket|reset_token|magic|nonce)$/i

/** Sanitizers live on `globalThis`, like consent: one page, one policy, however many SDK copies. */
const SANITIZERS_KEY = "__MAPLE_URL_SANITIZERS__"

function sanitizers(): Set<UrlSanitizer> {
	const owner = globalThis as Record<string, unknown>
	const existing = owner[SANITIZERS_KEY]
	if (existing instanceof Set) return existing as Set<UrlSanitizer>
	const fresh = new Set<UrlSanitizer>()
	owner[SANITIZERS_KEY] = fresh
	return fresh
}

/**
 * Register a host-app sanitizer. Additive, like the consent gates: an SDK
 * initialized without one must not remove the one another SDK was given.
 */
export function addUrlSanitizer(sanitizer: UrlSanitizer): void {
	sanitizers().add(sanitizer)
}

/** Test seam. */
export function resetUrlSanitizersForTests(): void {
	sanitizers().clear()
}

function redactParams(params: URLSearchParams): boolean {
	let changed = false
	for (const name of new Set(params.keys())) {
		if (!SENSITIVE_PARAM.test(name)) continue
		params.set(name, REDACTED)
		changed = true
	}
	return changed
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i
const RELATIVE_BASE = "http://relative.invalid"

/** Redact credential-shaped query and fragment parameters, keeping the URL's form. */
export function redactUrl(url: string): string {
	if (!url || (!url.includes("?") && !url.includes("#"))) return url
	const absolute = ABSOLUTE.test(url)
	let parsed: URL
	try {
		parsed = new URL(url, absolute ? undefined : RELATIVE_BASE)
	} catch {
		return url
	}
	let changed = redactParams(parsed.searchParams)
	// Implicit-flow tokens ride the fragment as `#access_token=…&…`. A hash
	// route (`#/settings`) has no `=` before its path and is left alone.
	const fragment = parsed.hash.slice(1)
	if (fragment.includes("=") && !fragment.startsWith("/")) {
		const params = new URLSearchParams(fragment)
		if (redactParams(params)) {
			parsed.hash = params.toString()
			changed = true
		}
	}
	if (!changed) return url
	if (absolute) return parsed.href
	const tail = `${parsed.pathname}${parsed.search}${parsed.hash}`
	return url.startsWith("/") ? tail : tail.replace(/^\//, "")
}

/**
 * The URL as it may leave the page: default redaction, then every registered
 * host sanitizer. A sanitizer that throws or returns a non-string yields the
 * default-redacted URL rather than the raw one.
 */
export function scrubUrl(url: string): string {
	let out = redactUrl(url)
	for (const sanitizer of sanitizers()) {
		try {
			const next = sanitizer(out)
			if (typeof next === "string") out = next
		} catch {
			// A broken host sanitizer must not throw into capture.
		}
	}
	return out
}

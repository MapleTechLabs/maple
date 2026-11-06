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
	/^(access_token|id_token|refresh_token|token|token_hash|auth|authorization|code|oobcode|state|password|passwd|pwd|pass|secret|client_secret|api_key|apikey|key|signature|sig|otp|jwt|session|sessionid|session_id|ticket|__clerk_ticket|reset_token|magic|nonce|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i

/**
 * Any name that, lowercased with `_`, `-` and `.` removed, ends in a credential
 * word: `accessToken`, `auth_token`, `user-token`, `__clerk_db_jwt`, `x-api-key`.
 * Suffix rather than substring, so `tokenizer_mode` or `secretary` stay readable.
 */
const CREDENTIAL_SUFFIX =
	/(token|secret|password|passwd|apikey|jwt|signature|credential|credentials|privatekey)$/

function isSensitiveName(name: string): boolean {
	return SENSITIVE_PARAM.test(name) || CREDENTIAL_SUFFIX.test(name.toLowerCase().replace(/[-_.]/g, ""))
}

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
export function addUrlSanitizer(sanitizer: UrlSanitizer): () => void {
	sanitizers().add(sanitizer)
	return () => void sanitizers().delete(sanitizer)
}

/** Test seam. */
export function resetUrlSanitizersForTests(): void {
	sanitizers().clear()
}

function redactParams(params: URLSearchParams): boolean {
	let changed = false
	for (const name of new Set(params.keys())) {
		if (!isSensitiveName(name)) continue
		params.set(name, REDACTED)
		changed = true
	}
	return changed
}

function redactQuery(query: string): string {
	const params = new URLSearchParams(query)
	return redactParams(params) ? params.toString() : query
}

/**
 * Implicit-flow tokens ride the fragment as `#access_token=…&…`; a hash-routed
 * app carries them in the route's own query, `#/reset?token=…` or `#reset?token=…`.
 * The route path is kept either way.
 */
function redactFragment(fragment: string): string {
	const queryAt = fragment.indexOf("?")
	const head = queryAt === -1 ? fragment : fragment.slice(0, queryAt)
	const isRoute = head.startsWith("/") || head.startsWith("!/") || !head.includes("=")
	const redactedHead = isRoute ? head : redactQuery(head)
	return queryAt === -1 ? redactedHead : `${redactedHead}?${redactQuery(fragment.slice(queryAt + 1))}`
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i
const RELATIVE_BASE = "http://relative.invalid"
/** `user:password@` after a scheme's `//`, for URLs the parser rejects. */
const USERINFO = /^([a-z][a-z0-9+.-]*:)?\/\/[^/?#@]*@/i
/** One `name=value` pair after a query, fragment or matrix separator. */
const PAIR = /([?&#;])([^=&#;?]*)=([^&#;?]*)/g

function decodeName(raw: string): string {
	try {
		return decodeURIComponent(raw.replace(/\+/g, " "))
	} catch {
		return raw
	}
}

/**
 * Best-effort redaction for a URL `new URL` rejects (`https://exa mple.com/?token=1`):
 * returning it raw would send exactly the credentials redaction exists to stop.
 */
function redactUnparsable(url: string): string {
	return url
		.replace(USERINFO, (_, scheme: string | undefined) => `${scheme ?? ""}//`)
		.replace(PAIR, (pair, separator: string, name: string) =>
			isSensitiveName(decodeName(name)) ? `${separator}${name}=${REDACTED}` : pair,
		)
}

/** Redact credentials in userinfo and in query and fragment parameters, keeping the URL's form. */
export function redactUrl(url: string): string {
	if (!url || !/[?#@;]/.test(url)) return url
	const absolute = ABSOLUTE.test(url)
	let parsed: URL
	try {
		parsed = new URL(url, absolute ? undefined : RELATIVE_BASE)
	} catch {
		return redactUnparsable(url)
	}
	let changed = redactParams(parsed.searchParams)
	if (parsed.username || parsed.password) {
		parsed.username = ""
		parsed.password = ""
		changed = true
	}
	const fragment = parsed.hash.slice(1)
	const redactedFragment = redactFragment(fragment)
	if (redactedFragment !== fragment) {
		parsed.hash = redactedFragment
		changed = true
	}
	if (!changed) return url
	if (absolute) return parsed.href
	// Protocol-relative (`//cdn.example.com/a`): keep the host, drop the base's scheme.
	if (url.startsWith("//")) return parsed.href.slice(parsed.protocol.length)
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

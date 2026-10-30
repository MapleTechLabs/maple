// First-party cookie plumbing. Every cookie this SDK writes must agree on one
// `Domain=`: a visit claim scoped host-only while the visitor id spans
// subdomains would stop deduplicating exactly on the marketing-site → app hop.

interface CookieScope {
	/** Scope cookies to the registered domain so subdomains share them. */
	crossSubdomainCookie: boolean
	/** Explicit `Domain=` override; `""` forces a host-only cookie. */
	cookieDomainOverride: string | undefined
	/** Memoized probe result. `undefined` = not resolved yet. */
	probedCookieDomain: string | undefined
}

/**
 * On `globalThis`, like consent: two bundled SDK copies writing the same cookies
 * under different `Domain=` scopes would each keep a copy the other cannot delete.
 */
const SCOPE_KEY = "__MAPLE_BROWSER_COOKIE_SCOPE__"

function scope(): CookieScope {
	const owner: Record<string, unknown> = globalThis
	const existing = owner[SCOPE_KEY]
	if (isCookieScope(existing)) return existing
	const fresh: CookieScope = {
		cookieDomainOverride: undefined,
		crossSubdomainCookie: true,
		probedCookieDomain: undefined,
	}
	owner[SCOPE_KEY] = fresh
	return fresh
}

function isCookieScope(value: unknown): value is CookieScope {
	return typeof value === "object" && value !== null && "crossSubdomainCookie" in value
}

/**
 * Apply the host app's cookie configuration. Called from `configurePrivacy`, so
 * both SDKs get it from the single call they already make.
 *
 * Like the consent gates, this only ever *tightens*: an app that initializes two
 * SDKs, only one of which passes a `privacy` block, must not have the other's
 * absent option widen the cookie back out to every subdomain.
 *
 * "Tighter" for `cookieDomain` means *narrower scope*, which is why this is not
 * first-write-wins: `""` (host-only) is the tightest value there is, and a
 * second SDK asking for it has to win over an earlier `"example.com"`. Between
 * two non-empty domains the shorter one is the broader (`example.com` covers
 * `app.example.com`, not the reverse), so the longer string wins.
 */
export function configureCookieScope(options: {
	readonly crossSubdomainCookie?: boolean | undefined
	readonly cookieDomain?: string | undefined
}): void {
	const state = scope()
	if (options.crossSubdomainCookie === false) state.crossSubdomainCookie = false
	if (options.cookieDomain !== undefined) {
		state.cookieDomainOverride = tighterCookieDomain(state.cookieDomainOverride, options.cookieDomain)
	}
	state.probedCookieDomain = undefined
}

/** The narrower of two `Domain=` values, treating `undefined` as "unset". */
export function tighterCookieDomain(current: string | undefined, next: string): string {
	if (current === undefined) return next
	// Host-only beats any domain-scoped cookie, whichever side asked for it.
	if (current === "" || next === "") return ""
	return next.length > current.length ? next : current
}

/** Every value stored under `name`: a host-only and a domain cookie can coexist. */
function readRawCookies(name: string): ReadonlyArray<string> {
	if (typeof document === "undefined") return []
	const values: string[] = []
	try {
		for (const part of document.cookie.split(";")) {
			const raw = part.trim()
			if (!raw.startsWith(`${name}=`)) continue
			try {
				values.push(decodeURIComponent(raw.slice(name.length + 1)))
			} catch {
				// Malformed percent-encoding (written by someone else): skip that one.
			}
		}
	} catch {
		// Cookies disabled entirely: indistinguishable from "not set".
	}
	return values
}

export function readRawCookie(name: string): string | undefined {
	return readRawCookies(name)[0]
}

/**
 * Write a cookie, returning whether the browser actually kept it. Assigning to
 * `document.cookie` succeeds silently when the cookie is refused (blocked,
 * oversized, bad `Domain=`), so a stored cookie is confirmed by reading it back.
 */
export function setRawCookie(name: string, value: string, domain: string, maxAgeSeconds: number): boolean {
	if (typeof document === "undefined") return false
	const attributes = [
		`${name}=${encodeURIComponent(value)}`,
		"path=/",
		`max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
		"SameSite=Lax",
	]
	if (domain) attributes.push(`domain=.${domain}`)
	// A `Secure` cookie is rejected over http, which is exactly the local-dev case.
	if (typeof location !== "undefined" && location.protocol === "https:") attributes.push("Secure")
	try {
		document.cookie = attributes.join("; ")
	} catch {
		return false
	}
	return maxAgeSeconds <= 0 || readRawCookies(name).includes(value)
}

/**
 * Expire `name` host-only and on every parent domain it could have been scoped
 * to: it may predate a narrowed scope. Expiring a cookie that does not exist
 * stores nothing, unlike the domain probe, so a memory-only opt-out stays clean.
 */
export function deleteRawCookie(name: string): void {
	setRawCookie(name, "", "", 0)
	const hostname = typeof location === "undefined" ? "" : location.hostname
	for (const domain of candidateDomains(hostname)) setRawCookie(name, "", domain, 0)
	const override = scope().cookieDomainOverride
	if (override) setRawCookie(name, "", override, 0)
}

/**
 * Parent domains of `hostname`, broadest first. Empty for single-label hosts,
 * IPs, and hosts with an empty label (`example.com.`), whose suffixes are not domains.
 */
export function candidateDomains(hostname: string): ReadonlyArray<string> {
	if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return []
	const parts = hostname.split(".")
	if (parts.includes("")) return []
	const candidates: string[] = []
	for (let i = parts.length - 2; i >= 0; i--) candidates.push(parts.slice(i).join("."))
	return candidates
}

/**
 * The broadest domain this browser will actually accept a cookie for, found by
 * probing rather than by carrying a public-suffix list, the same trick
 * posthog-js uses. Candidates start at the broadest (the last two labels) and
 * narrow a label at a time, with the first that sticks winning, so
 * `app.example.co.uk` tries the rejected `co.uk`, then lands on `example.co.uk`.
 *
 * Returns `""` (host-only cookie) for single-label hosts like `localhost` and
 * for bare IPs, neither of which can carry a `Domain=` attribute.
 */
function probeCookieDomain(): string {
	if (typeof document === "undefined" || typeof location === "undefined") return ""
	const probe = "__maple_probe"
	// Random, so another tab probing at the same moment cannot confirm our candidate.
	const value = Math.random().toString(36).slice(2)
	for (const candidate of candidateDomains(location.hostname)) {
		if (setRawCookie(probe, value, candidate, 60)) {
			setRawCookie(probe, "", candidate, 0)
			return candidate
		}
	}
	return ""
}

export function cookieDomain(): string {
	const state = scope()
	if (state.cookieDomainOverride !== undefined) return state.cookieDomainOverride
	if (!state.crossSubdomainCookie) return ""
	if (state.probedCookieDomain === undefined) state.probedCookieDomain = probeCookieDomain()
	return state.probedCookieDomain
}

/** Test seam: drops the memoized domain and any configured scope. */
export function resetCookieScopeForTests(): void {
	const state = scope()
	state.crossSubdomainCookie = true
	state.cookieDomainOverride = undefined
	state.probedCookieDomain = undefined
}

import { Effect, Option, Result, Schema } from "effect"
import { constTrue } from "effect/Function"
import { FetchHttpClient, HttpClient, HttpClientRequest, Url } from "effect/http"
import type { HttpClientError, HttpClientResponse } from "effect/http"

export class UrlValidationError extends Schema.TaggedError<UrlValidationError>()(
	"@maple/safe-fetch/UrlValidationError",
	{
		message: Schema.String,
		url: Schema.optional(Schema.String),
	},
) {}

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"broadcasthost",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"metadata.azure.com",
])

const PRIVATE_IPV4_PATTERNS: ReadonlyArray<RegExp> = [
	/^0(?:\.|$)/,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(?:1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^198\.(?:1[8-9])\./,
	/^255\.255\.255\.255$/,
	// IETF protocol assignments — `192.0.0.192` is Oracle Cloud's metadata address.
	/^192\.0\.0\./,
	// Documentation ranges: never routable, so a request to one is a probe.
	/^192\.0\.2\./,
	/^198\.51\.100\./,
	/^203\.0\.113\./,
	// Multicast (224/4) and reserved (240/4).
	/^(?:22[4-9]|23\d)\./,
	/^(?:24\d|25[0-5])\./,
]

const PRIVATE_IPV6_PATTERNS: ReadonlyArray<RegExp> = [
	/^::1$/,
	/^::$/,
	/^fc[0-9a-f]{2}:/i,
	/^fd[0-9a-f]{2}:/i,
	// Link-local is `fe80::/10` — `fe80:` alone is `/16`, which let `fe9f::1`,
	// `fea0::1` and everything up to `febf:…` through.
	/^fe[89ab][0-9a-f]:/i,
	// Site-local: deprecated, still routed on plenty of internal networks.
	/^fe[cdef][0-9a-f]:/i,
]

// Transition mechanisms that carry an IPv4 destination inside an IPv6 address:
// the packet ends up at the embedded address, so it has to face the IPv4 rules.
// `2002:7f00:0001::` is 6to4 for 127.0.0.1; `64:ff9b::7f00:1` is NAT64.
const SIX_TO_FOUR_RE = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i
const NAT64_RE = /^64:ff9b(?::0)*::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
const NAT64_DOTTED_RE = /^64:ff9b(?::0)*::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are canonicalised by most URL
// parsers to the hex form `::ffff:HHHH:HHHH`, with leading zeros stripped from
// each group (e.g. `10.0.0.1` → `::ffff:a00:1`). Decode the hex back to
// dotted-quad and apply the IPv4 private-range check.
const IPV4_MAPPED_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
const IPV4_MAPPED_DOTTED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

const decodeIPv4MappedIPv6 = (inner: string): string | null => {
	const dotted = IPV4_MAPPED_DOTTED_RE.exec(inner)
	if (dotted) return dotted[1]
	const hex = IPV4_MAPPED_RE.exec(inner)
	if (!hex) return null
	const hi = Number.parseInt(hex[1], 16)
	const lo = Number.parseInt(hex[2], 16)
	if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return null
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

/**
 * The patterns above are prefix matches, which is only sound against something
 * already known to be an IPv4 literal: `/^10\./` says yes to the perfectly
 * ordinary hostname `10.example.com`, and the widened multicast and reserved
 * ranges would do the same to `240.example.com`. A URL parser normalises every
 * accepted IPv4 form — decimal, octal, hex — to a dotted quad, so anything that
 * is an address at all reaches here looking like one.
 */
const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

const isPrivateIPv4 = (host: string): boolean =>
	IPV4_LITERAL_RE.test(host) && PRIVATE_IPV4_PATTERNS.some((re) => re.test(host))

const hexPairToDotted = (hi: string, lo: string): string | null => {
	const high = Number.parseInt(hi, 16)
	const low = Number.parseInt(lo, 16)
	if (!Number.isFinite(high) || !Number.isFinite(low) || high > 0xffff || low > 0xffff) return null
	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

/** The IPv4 address an IPv6 literal ultimately delivers to, if it embeds one. */
const embeddedIPv4 = (inner: string): string | null => {
	const mapped = decodeIPv4MappedIPv6(inner)
	if (mapped) return mapped
	const nat64Dotted = NAT64_DOTTED_RE.exec(inner)
	if (nat64Dotted) return nat64Dotted[1]
	const nat64 = NAT64_RE.exec(inner)
	if (nat64) return hexPairToDotted(nat64[1], nat64[2])
	const sixToFour = SIX_TO_FOUR_RE.exec(inner)
	if (sixToFour) return hexPairToDotted(sixToFour[1], sixToFour[2])
	return null
}

const isPrivateIPv6 = (host: string): boolean => {
	const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
	if (PRIVATE_IPV6_PATTERNS.some((re) => re.test(inner))) return true
	const embedded = embeddedIPv4(inner)
	if (embedded && isPrivateIPv4(embedded)) return true
	return false
}

/**
 * A trailing dot makes a name fully qualified — `localhost.` and `localhost`
 * resolve identically — but it is kept verbatim by the URL parser, so a blocklist
 * keyed on the bare name never matched it. Strip it before every name comparison.
 */
const canonicalHostname = (hostname: string): string => {
	const lower = hostname.toLowerCase()
	return lower.endsWith(".") ? lower.slice(0, -1) : lower
}

const isPrivateHost = (hostname: string): boolean => {
	const lower = canonicalHostname(hostname)
	if (BLOCKED_HOSTNAMES.has(lower)) return true
	if (isPrivateIPv4(lower)) return true
	if (isPrivateIPv6(lower)) return true
	return false
}

/**
 * Parse `raw` and reject anything Maple must not send a request to: non-http(s)
 * schemes, embedded credentials, and loopback / private / metadata hosts.
 */
export const parseExternalUrl = (raw: string): Result.Result<URL, UrlValidationError> => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		return Result.fail(new UrlValidationError({ message: "URL is required" }))
	}
	if (!URL.canParse(trimmed)) {
		return Result.fail(new UrlValidationError({ message: `Invalid URL: ${trimmed}`, url: trimmed }))
	}
	const parsed = new URL(trimmed)
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return Result.fail(
			new UrlValidationError({
				message: `URL scheme '${parsed.protocol}' is not allowed; use http or https`,
				url: trimmed,
			}),
		)
	}
	if (parsed.hostname.length === 0) {
		return Result.fail(new UrlValidationError({ message: "URL must include a hostname", url: trimmed }))
	}
	// Credentials in the URL are both a way to smuggle a second host past a
	// reader (`https://real.example.com@internal/`, where the parser's host is
	// `internal`) and a way to have Maple replay them at the destination.
	if (parsed.username !== "" || parsed.password !== "") {
		return Result.fail(
			new UrlValidationError({ message: "URL must not embed credentials", url: trimmed }),
		)
	}
	if (isPrivateHost(parsed.hostname)) {
		return Result.fail(
			new UrlValidationError({
				message: `URL host '${parsed.hostname}' is not allowed (loopback, private, or metadata range)`,
				url: trimmed,
			}),
		)
	}
	return Result.succeed(parsed)
}

export const validateExternalUrl = (raw: string): Effect.Effect<URL, UrlValidationError> =>
	Effect.suspend(() => Effect.fromResult(parseExternalUrl(raw)))

const MAX_REDIRECTS = 5

/**
 * Headers that authenticate the caller to a specific origin. Validating a
 * redirect's destination says it is not internal; it says nothing about whether
 * it should be handed the credential meant for the origin we started at.
 */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const

const withoutCredentialHeaders = (request: HttpClientRequest.HttpClientRequest) =>
	CREDENTIAL_HEADERS.reduce((next, name) => HttpClientRequest.removeHeader(next, name), request)

/** The full URL a request targets, query params and hash included. */
const requestUrl = (request: HttpClientRequest.HttpClientRequest) =>
	Effect.fromResult(Url.make(request.url, request.urlParams, Option.getOrUndefined(request.hash))).pipe(
		Effect.mapError(
			() => new UrlValidationError({ message: `Invalid URL: ${request.url}`, url: request.url }),
		),
	)

/**
 * Wrap a fetch-backed `HttpClient` so it only reaches external hosts, for URLs
 * that came from user configuration.
 *
 * - Every hop is validated, redirects included. `HttpClient.followRedirects`
 *   cannot do this: it re-runs only `postprocess` per hop, so a check placed in
 *   `mapRequest*` would see the first URL and nothing after it.
 * - Redirects are followed here with `redirect: "manual"`, at most 5.
 * - A cross-origin hop drops credential headers for good: restoring them on a
 *   bounce back to the original origin would make the strip trivially
 *   bypassable by redirecting away and back again.
 * - The client's own span is disabled. It records `url.full`, and the URLs this
 *   guards routinely carry credentials (signed query params, webhook tokens in
 *   the path). Callers open their own client span with safe attributes.
 */
export const guard = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
): HttpClient.HttpClient.With<E | UrlValidationError, R> => {
	const send = (request: HttpClientRequest.HttpClientRequest) =>
		Effect.serviceOption(FetchHttpClient.RequestInit).pipe(
			Effect.flatMap((init) =>
				client.execute(request).pipe(
					Effect.provideService(FetchHttpClient.RequestInit, {
						...Option.getOrUndefined(init),
						redirect: "manual",
					}),
					Effect.provideService(HttpClient.TracerDisabledWhen, constTrue),
				),
			),
		)

	const hop = (
		request: HttpClientRequest.HttpClientRequest,
		redirects: number,
		previousOrigin: string | null,
	): Effect.Effect<HttpClientResponse.HttpClientResponse, E | UrlValidationError, R> =>
		Effect.gen(function* () {
			const validated = yield* requestUrl(request).pipe(
				Effect.flatMap((url) => validateExternalUrl(url.toString())),
			)
			const outgoing =
				previousOrigin !== null && validated.origin !== previousOrigin
					? withoutCredentialHeaders(request)
					: request
			const response = yield* send(outgoing)
			if (response.status < 300 || response.status >= 400) return response
			const location = response.headers["location"]
			// An empty Location resolves to the current URL; following it would
			// resend the same request until the cap.
			if (!location) return response
			if (redirects >= MAX_REDIRECTS) {
				return yield* new UrlValidationError({
					message: `Too many redirects (>${MAX_REDIRECTS})`,
					url: validated.toString(),
				})
			}
			if (!URL.canParse(location, validated.href)) {
				return yield* new UrlValidationError({ message: "Redirect has an invalid Location header" })
			}
			const next = HttpClientRequest.setUrl(outgoing, new URL(location, validated))
			return yield* hop(next, redirects + 1, validated.origin)
		})

	return HttpClient.makeWith<E | UrlValidationError, R, E | UrlValidationError, R>(
		(request) => Effect.flatMap(request, (initial) => hop(initial, 0, null)),
		Effect.succeed,
	)
}

/**
 * An `HttpClientError` message without the request URL. Effect's own messages
 * embed `METHOD url`, and the URLs `guard` sees routinely carry credentials.
 */
export const describeHttpClientError = (error: HttpClientError.HttpClientError): string => {
	const { cause, description, request } = error.reason
	const message = cause instanceof Error ? cause.message : (description ?? error.reason._tag)
	// Some runtimes put the URL in the cause's own message; keep only its origin.
	const url = Url.make(request.url, request.urlParams, Option.getOrUndefined(request.hash))
	if (Result.isFailure(url)) return message
	return [url.success.href, request.url].reduce(
		(redacted, secret) => redacted.split(secret).join(url.success.origin),
		message,
	)
}

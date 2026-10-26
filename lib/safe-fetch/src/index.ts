import { Effect, Option, Result, Schema, Stream } from "effect"
import { constTrue } from "effect/Function"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, Url } from "effect/http"
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

// Names under these suffixes only resolve inside a private network: special-use
// and split-horizon zones, mDNS, and in-cluster service discovery.
const BLOCKED_HOSTNAME_SUFFIXES: ReadonlyArray<string> = [
	"internal",
	"local",
	"localhost",
	"localdomain",
	"lan",
	"home.arpa",
	"intranet",
	"corp",
	"cluster.local",
	"svc",
]

const hasBlockedSuffix = (name: string): boolean =>
	BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))

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

/**
 * The eight 16-bit groups of an IPv6 literal, or `null` when it is not one.
 * The URL parser hands us the compressed hex form (`[::7f00:1]`), but a
 * trailing dotted quad is accepted too so direct callers get the same answer.
 */
const ipv6Groups = (inner: string): ReadonlyArray<number> | null => {
	const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(inner)
	const quad = dotted ? dotted[2].split(".").map(Number) : null
	if (quad && quad.some((octet) => octet > 255)) return null
	const hexTail = quad
		? `${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`
		: null
	const head = dotted && hexTail ? `${dotted[1]}${hexTail}` : inner
	const halves = head.split("::")
	if (halves.length > 2) return null
	const parse = (part: string) => (part === "" ? [] : part.split(":"))
	const left = parse(halves[0])
	const right = halves.length === 2 ? parse(halves[1]) : []
	const missing = 8 - left.length - right.length
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null
	const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
	if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null
	return groups.map((group) => Number.parseInt(group, 16))
}

const dottedFrom = (hi: number, lo: number): string =>
	`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`

const zeroed = (groups: ReadonlyArray<number>, from: number, to: number): boolean =>
	groups.slice(from, to).every((group) => group === 0)

/**
 * What an IPv6 literal delivers to, judged on its groups:
 * - refused: loopback, unspecified, ULA (`fc00::/7`, AWS's `fd00:ec2::254`),
 *   link-local, site-local, multicast, and the transition forms whose IPv4 is
 *   not recoverable or never public: IPv4-compatible `::a.b.c.d`, SIIT
 *   `::ffff:0:a.b.c.d`, NAT64 local-use `64:ff9b:1::/48` and Teredo `2001::/32`.
 * - mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` carry an
 *   IPv4 address in a fixed place, so that address faces the IPv4 rules.
 */
const isPrivateIPv6Groups = (groups: ReadonlyArray<number>): boolean => {
	const [g0, g1, g2] = groups
	if (zeroed(groups, 0, 6)) return true
	if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xff00) === 0xff00) return true
	if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true
	if (zeroed(groups, 0, 4) && groups[4] === 0xffff && groups[5] === 0) return true
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true
	if (g0 === 0x2001 && g1 === 0) return true
	const tail = dottedFrom(groups[6], groups[7])
	if (zeroed(groups, 0, 5) && groups[5] === 0xffff) return isPrivateIPv4(tail)
	if (g0 === 0x64 && g1 === 0xff9b && zeroed(groups, 2, 6)) return isPrivateIPv4(tail)
	if (g0 === 0x2002) return isPrivateIPv4(dottedFrom(g1, g2))
	return false
}

/** A bracketed host that is not a well-formed IPv6 literal is refused, not guessed at. */
const isPrivateIPv6 = (host: string): boolean => {
	const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
	const groups = ipv6Groups(inner)
	if (groups === null) return host.startsWith("[") || inner.includes(":")
	return isPrivateIPv6Groups(groups)
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
	if (BLOCKED_HOSTNAMES.has(lower) || hasBlockedSuffix(lower)) return true
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

const withoutHeaders = (request: HttpClientRequest.HttpClientRequest) =>
	Object.keys(request.headers).reduce((next, name) => HttpClientRequest.removeHeader(next, name), request)

/** How `guard` hands a request on to a redirect's destination. */
export interface GuardOptions {
	/**
	 * For requests whose headers all come from user config: a cross-origin hop drops every
	 * header, 301/302/303 continue as a body-less GET, and 307/308 keep method and body only
	 * within one origin. Without it, only credential headers are dropped cross-origin.
	 */
	readonly strictRedirects?: boolean
}

const SEE_OTHER_STATUSES: ReadonlySet<number> = new Set([301, 302, 303])

/** The request a strict redirect sends: HEAD stays HEAD, anything else replays as a plain GET. */
const strictRedirectRequest = (
	request: HttpClientRequest.HttpClientRequest,
	status: number,
	crossOrigin: boolean,
) => {
	if (!SEE_OTHER_STATUSES.has(status) && !crossOrigin) return request
	const bodyless = HttpClientRequest.setBody(request, HttpBody.empty)
	return request.method === "HEAD" ? bodyless : HttpClientRequest.setMethod(bodyless, "GET")
}

/** The full URL a request targets, query params and hash included. */
const requestUrl = (request: HttpClientRequest.HttpClientRequest) =>
	Effect.fromResult(Url.make(request.url, request.urlParams, Option.getOrUndefined(request.hash))).pipe(
		Effect.mapError(
			() => new UrlValidationError({ message: `Invalid URL: ${request.url}`, url: request.url }),
		),
	)

export class HostResolutionError extends Schema.TaggedError<HostResolutionError>()(
	"@maple/safe-fetch/HostResolutionError",
	{
		message: Schema.String,
		hostname: Schema.String,
	},
) {}

/** Every address `hostname` resolves to. Injected so the caller owns DNS, and tests need none. */
export type ResolveHost = (hostname: string) => Effect.Effect<ReadonlyArray<string>, HostResolutionError>

/** A resolved address, judged by the same rules as a literal host. Unparseable answers are refused. */
export const isPrivateAddress = (address: string): boolean =>
	address.includes(":") ? isPrivateIPv6(address) : !IPV4_LITERAL_RE.test(address) || isPrivateIPv4(address)

/** The request a hop actually sends, and the TLS name to verify when it dials an address. */
interface Dial {
	readonly request: HttpClientRequest.HttpClientRequest
	readonly serverName: string | null
}

const pinTo =
	(resolve: ResolveHost) =>
	(
		request: HttpClientRequest.HttpClientRequest,
		url: URL,
	): Effect.Effect<Dial, UrlValidationError | HostResolutionError> =>
		Effect.gen(function* () {
			const hostname = canonicalHostname(url.hostname)
			if (IPV4_LITERAL_RE.test(hostname) || hostname.startsWith("["))
				return { request, serverName: null }
			const addresses = yield* resolve(hostname)
			// Every answer is checked, so any is safe; IPv4 first because not every
			// network that resolves AAAA can route IPv6.
			const first = addresses.find((address) => !address.includes(":")) ?? addresses[0]
			if (first === undefined || addresses.some(isPrivateAddress)) {
				return yield* new UrlValidationError({
					message: `URL host '${url.hostname}' resolves to a loopback, private, or metadata address`,
				})
			}
			const pinned = new URL(url)
			pinned.hostname = first.includes(":") ? `[${first}]` : first
			return {
				request: HttpClientRequest.setUrl(request, pinned).pipe(
					HttpClientRequest.setHeader("host", url.host),
				),
				serverName: hostname,
			}
		})

const guardWith = <E, R, E2>(
	client: HttpClient.HttpClient.With<E, R>,
	dial: (request: HttpClientRequest.HttpClientRequest, url: URL) => Effect.Effect<Dial, E2>,
	options: GuardOptions,
): HttpClient.HttpClient.With<E | E2 | UrlValidationError, R> => {
	const strict = options.strictRedirects === true
	const send = ({ request, serverName }: Dial) =>
		Effect.serviceOption(FetchHttpClient.RequestInit).pipe(
			Effect.flatMap((init) =>
				client.execute(request).pipe(
					Effect.provideService(FetchHttpClient.RequestInit, {
						...Option.getOrUndefined(init),
						redirect: "manual",
						...(serverName === null ? undefined : { tls: { serverName } }),
					}),
					Effect.provideService(HttpClient.TracerDisabledWhen, constTrue),
				),
			),
		)

	const hop = (
		request: HttpClientRequest.HttpClientRequest,
		redirects: number,
		previousOrigin: string | null,
	): Effect.Effect<HttpClientResponse.HttpClientResponse, E | E2 | UrlValidationError, R> =>
		Effect.gen(function* () {
			const validated = yield* requestUrl(request).pipe(
				Effect.flatMap((url) => validateExternalUrl(url.toString())),
			)
			const outgoing =
				previousOrigin !== null && validated.origin !== previousOrigin
					? strict
						? withoutHeaders(request)
						: withoutCredentialHeaders(request)
					: request
			const response = yield* send(yield* dial(outgoing, validated))
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
			const target = new URL(location, validated)
			const next = HttpClientRequest.setUrl(
				strict
					? strictRedirectRequest(outgoing, response.status, target.origin !== validated.origin)
					: outgoing,
				target,
			)
			return yield* hop(next, redirects + 1, validated.origin)
		})

	return HttpClient.makeWith<E | E2 | UrlValidationError, R, E | E2 | UrlValidationError, R>(
		(request) => Effect.flatMap(request, (initial) => hop(initial, 0, null)),
		Effect.succeed,
	)
}

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
 *
 * Hostnames are checked by name only: the runtime resolves them after the
 * check. Use this where the network cannot reach private ranges anyway
 * (Cloudflare Workers, whose fetch cannot pick a peer address); use
 * `guardPinned` in a process that can.
 */
export const guard = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
	options: GuardOptions = {},
): HttpClient.HttpClient.With<E | UrlValidationError, R> =>
	guardWith(client, (request) => Effect.succeed({ request, serverName: null }), options)

/**
 * `guard`, plus DNS pinning for processes inside a private network: each hop's
 * hostname is resolved once with `resolve`, refused if any address is private,
 * and the request dials the first address with the name kept for `Host` and
 * TLS (`tls.serverName`, which Bun's fetch verifies the certificate against).
 */
export const guardPinned = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
	resolve: ResolveHost,
	options: GuardOptions = {},
): HttpClient.HttpClient.With<E | UrlValidationError | HostResolutionError, R> =>
	guardWith(client, pinTo(resolve), options)

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

export class ResponseTooLargeError extends Schema.TaggedError<ResponseTooLargeError>()(
	"@maple/safe-fetch/ResponseTooLargeError",
	{
		message: Schema.String,
		maxBytes: Schema.Number,
	},
) {}

export interface TextPrefix {
	readonly text: string
	/** The body had more than `maxBytes`; the rest was never read. */
	readonly truncated: boolean
}

interface Piece {
	readonly bytes: Uint8Array
	readonly over: boolean
}

/**
 * At most the first `maxBytes` of a body, as text. Reading stops (and the body
 * is cancelled) once the budget is spent, so a large or endless response
 * costs no more than the budget. For bodies only shown as a detail.
 */
export const readTextPrefix = (
	response: HttpClientResponse.HttpClientResponse,
	maxBytes: number,
): Effect.Effect<TextPrefix, HttpClientError.HttpClientError> =>
	Effect.suspend(() => {
		const decoder = new TextDecoder()
		return response.stream.pipe(
			Stream.mapAccum(
				() => 0,
				(seen, chunk: Uint8Array) => {
					const room = Math.max(0, maxBytes - seen)
					const piece: Piece = { bytes: chunk.subarray(0, room), over: chunk.byteLength > room }
					return [seen + piece.bytes.byteLength, [piece]] as const
				},
			),
			Stream.takeUntil((piece) => piece.over),
			Stream.runFold(
				(): TextPrefix => ({ text: "", truncated: false }),
				(acc, piece): TextPrefix => ({
					text: acc.text + decoder.decode(piece.bytes, { stream: true }),
					truncated: piece.over,
				}),
			),
			Effect.map(({ text, truncated }) => ({ text: text + decoder.decode(), truncated })),
		)
	})

/**
 * A whole body as text, failing with `ResponseTooLargeError` instead of
 * buffering past `maxBytes`. A declared `Content-Length` over it fails before
 * reading; the byte count catches chunked and lying bodies.
 */
export const readTextWithin = (
	response: HttpClientResponse.HttpClientResponse,
	maxBytes: number,
): Effect.Effect<string, HttpClientError.HttpClientError | ResponseTooLargeError> => {
	const tooLarge = new ResponseTooLargeError({
		message: `response body exceeded ${maxBytes} bytes`,
		maxBytes,
	})
	const declared = Number(response.headers["content-length"] ?? Number.NaN)
	if (Number.isFinite(declared) && declared > maxBytes) return Effect.fail(tooLarge)
	return readTextPrefix(response, maxBytes).pipe(
		Effect.flatMap(({ text, truncated }) => (truncated ? Effect.fail(tooLarge) : Effect.succeed(text))),
	)
}

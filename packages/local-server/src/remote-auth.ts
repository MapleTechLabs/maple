// Authentication for a local server reachable beyond loopback: an ingest key
// for OTLP writes and an access token (sign-in page, session cookie, or Bearer)
// for everything that reads. Both come from the environment, never argv.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { Result, Schema, Array as Arr, String as Str } from "effect"

export const INGEST_KEY_ENV = "MAPLE_LOCAL_INGEST_KEY"
export const ACCESS_TOKEN_ENV = "MAPLE_LOCAL_ACCESS_TOKEN"

/** Shortest accepted secret: the sign-in page is reachable by anyone who finds the URL. */
export const MIN_SECRET_LENGTH = 16

export const SESSION_COOKIE = "maple_local_session"
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const LOGIN_PATH = "/login"
export const LOGIN_ACTION_PATH = "/local/auth/login"
/** The 401 body for an API call without the access token; the CLI reads it to name the fix. */
export const SIGN_IN_REQUIRED = "sign in required"

export class RemoteAuthConfigError extends Schema.TaggedError<RemoteAuthConfigError>()(
	"@maple/cli/RemoteAuthConfigError",
	{ message: Schema.String, source: Schema.String },
) {}

export interface RemoteAuth {
	/** Required on `/v1/*` when set. Write-only: it never grants a read. */
	readonly ingestKey: string | undefined
	/** Required on every other route except `/health` when set. */
	readonly accessToken: string | undefined
}

export const NO_REMOTE_AUTH: RemoteAuth = { ingestKey: undefined, accessToken: undefined }

const readSecret = (
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): Result.Result<string | undefined, RemoteAuthConfigError> => {
	const value = env[name]?.trim()
	if (value === undefined || value === "") return Result.succeed(undefined)
	return value.length < MIN_SECRET_LENGTH
		? Result.fail(
				new RemoteAuthConfigError({
					source: name,
					message: `${name} must be at least ${MIN_SECRET_LENGTH} characters (generate one with \`openssl rand -hex 32\`)`,
				}),
			)
		: Result.succeed(value)
}

export const remoteAuthFromEnv = (
	env: Readonly<Record<string, string | undefined>>,
): Result.Result<RemoteAuth, RemoteAuthConfigError> =>
	Result.gen(function* () {
		const ingestKey = yield* readSecret(env, INGEST_KEY_ENV)
		const accessToken = yield* readSecret(env, ACCESS_TOKEN_ENV)
		return { ingestKey, accessToken }
	})

/** Constant-time comparison that does not leak the expected secret's length. */
export const secretMatches = (expected: string, supplied: string | null | undefined): boolean => {
	if (supplied === null || supplied === undefined) return false
	const digest = (value: string) => createHash("sha256").update(value).digest()
	return timingSafeEqual(digest(expected), digest(supplied))
}

const bearerToken = (req: Request): string | null => {
	const header = req.headers.get("authorization")
	const match = header?.match(/^Bearer\s+(.+)$/i)
	return match?.[1]?.trim() ?? null
}

/** The ingest key as Maple's cloud ingest accepts it: `x-maple-ingest-key` or a Bearer token. */
export const presentedIngestKey = (req: Request): string | null =>
	req.headers.get("x-maple-ingest-key") ?? bearerToken(req)

const readCookie = (req: Request, name: string): string | null => {
	for (const part of Str.split(";")(req.headers.get("cookie") ?? "")) {
		const separator = part.indexOf("=")
		if (separator !== -1 && Str.trim(Str.slice(0, separator)(part)) === name)
			return Str.trim(Str.slice(separator + 1)(part))
	}
	return null
}

// Sessions are stateless: `<expiresAtMs>.<hmac>`, keyed by the access token, so
// rotating the token signs every browser out and a restart signs nobody out.
const sessionSignature = (accessToken: string, expiresAtMs: number): string => {
	const key = createHmac("sha256", accessToken).update("maple-local-session-v1").digest()
	return createHmac("sha256", key).update(`v1.${expiresAtMs}`).digest("base64url")
}

export const issueSession = (accessToken: string, nowMs: number): string => {
	const expiresAtMs = nowMs + SESSION_TTL_MS
	return `${expiresAtMs}.${sessionSignature(accessToken, expiresAtMs)}`
}

export const sessionValid = (accessToken: string, value: string | null, nowMs: number): boolean => {
	const match = value?.match(/^(\d{1,16})\.([\w-]{43})$/)
	if (!match) return false
	const expiresAtMs = Number(match[1])
	if (expiresAtMs <= nowMs) return false
	const expected = Buffer.from(sessionSignature(accessToken, expiresAtMs))
	const supplied = Buffer.from(match[2] ?? "")
	return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

/** Requests through a TLS-terminating proxy arrive as plain HTTP with `x-forwarded-proto`. */
const isSecureRequest = (req: Request, url: URL): boolean =>
	url.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"

export const sessionCookie = (req: Request, url: URL, value: string): string =>
	Arr.join(
		[
			`${SESSION_COOKIE}=${value}`,
			"Path=/",
			`Max-Age=${SESSION_TTL_MS / 1000}`,
			"HttpOnly",
			"SameSite=Lax",
			...(isSecureRequest(req, url) ? ["Secure"] : []),
		],
		"; ",
	)

export const hasValidSession = (auth: RemoteAuth, req: Request, nowMs: number): boolean =>
	auth.accessToken !== undefined && sessionValid(auth.accessToken, readCookie(req, SESSION_COOKIE), nowMs)

const OTLP_PATHS = new Set(["/v1/traces", "/v1/logs", "/v1/metrics"])
/** The only routes an event consumer's token opens. */
const CONSUMER_PATHS = new Set(["/local/eventing/claims", "/local/eventing/acks"])

/** Machine credentials the server already issues to local tooling (`maple checkpoint`,
 * event consumers). Routes that take them keep checking them themselves. */
export interface LocalCredentials {
	readonly maintenanceToken: string
	readonly consumerToken: string
}

const unauthorized = (message: string): Response =>
	new Response(message, {
		status: 401,
		headers: { "content-type": "text/plain", "www-authenticate": 'Bearer realm="maple"' },
	})

/**
 * The access decision for one request: `null` lets it through to routing, a
 * `Response` answers it. `/health` stays open for platform health checks.
 */
export const accessDenied = (
	auth: RemoteAuth,
	credentials: LocalCredentials,
	req: Request,
	url: URL,
	nowMs: number,
	attempts: CredentialAttempts,
): Response | null => {
	if (url.pathname === "/health") return null
	if (OTLP_PATHS.has(url.pathname))
		return auth.ingestKey === undefined || secretMatches(auth.ingestKey, presentedIngestKey(req))
			? null
			: unauthorized("ingest key required")
	// SDKs send their ingest key to other hosted `/v1/*` routes; that is no access-token guess.
	if (auth.accessToken !== undefined && Str.startsWith("/v1/")(url.pathname))
		return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
	if (auth.accessToken === undefined) return null
	if (url.pathname === LOGIN_PATH || url.pathname === LOGIN_ACTION_PATH) return null
	if (
		hasValidSession(auth, req, nowMs) ||
		(Str.startsWith("/local/")(url.pathname) &&
			secretMatches(credentials.maintenanceToken, req.headers.get("x-maple-maintenance-token"))) ||
		(CONSUMER_PATHS.has(url.pathname) &&
			secretMatches(credentials.consumerToken, req.headers.get("x-maple-event-consumer-token")))
	)
		return null
	const bearer = bearerToken(req)
	if (bearer !== null) {
		// A Bearer guess counts against the same limit as a sign-in, checked before the compare.
		const retryAfterMs = attempts.throttle.retryAfterMs(attempts.client, nowMs)
		if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs)
		if (secretMatches(auth.accessToken, bearer)) return null
		attempts.throttle.recordFailure(attempts.client, nowMs)
	}
	// A page load goes to the sign-in page; API calls get a 401 their client can act on.
	if (req.method === "GET" && !Str.startsWith("/local/")(url.pathname))
		return new Response(null, { status: 303, headers: { location: LOGIN_PATH } })
	return unauthorized(SIGN_IN_REQUIRED)
}

/**
 * Failed credential attempts (sign-ins and Bearer tokens) per client, under a
 * higher server-wide ceiling. Past either limit, attempts answer 429 until the
 * oldest counted failure leaves the window.
 */
export class LoginThrottle {
	readonly #failures: Array<{ readonly client: string; readonly atMs: number }> = []
	constructor(
		readonly perClientLimit = 10,
		readonly serverLimit = 100,
		readonly windowMs = 60_000,
	) {}

	#prune(nowMs: number): void {
		while (this.#failures.length > 0 && (this.#failures[0]?.atMs ?? 0) <= nowMs - this.windowMs)
			this.#failures.shift()
	}

	#retryAfter(failures: ReadonlyArray<{ readonly atMs: number }>, limit: number, nowMs: number): number {
		const oldest = failures[0]
		return failures.length < limit || oldest === undefined ? 0 : oldest.atMs + this.windowMs - nowMs
	}

	/** Milliseconds until `client` may try again; 0 when allowed now. */
	retryAfterMs(client: string, nowMs: number): number {
		this.#prune(nowMs)
		// Failures are only recorded below the server limit, so this scan stays short.
		const own = this.#failures.filter((failure) => failure.client === client)
		return Math.max(
			this.#retryAfter(this.#failures, this.serverLimit, nowMs),
			this.#retryAfter(own, this.perClientLimit, nowMs),
		)
	}

	recordFailure(client: string, nowMs: number): void {
		this.#prune(nowMs)
		this.#failures.push({ client, atMs: nowMs })
	}
}

/** Who is guessing, for {@link LoginThrottle}: see {@link throttleClientKey}. */
export interface CredentialAttempts {
	readonly throttle: LoginThrottle
	readonly client: string
}

/** The peer address as a throttle key: IPv4 as is (mapped too), IPv6 by its /64,
 * since one host usually holds a whole /64. */
export const throttleClientKey = (address: string): string => {
	const bare = Str.split("%")(address)[0] ?? address
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1]
	if (mapped !== undefined) return mapped
	if (!Str.includes(":")(bare)) return bare
	const [head = "", tail] = Str.split("::")(bare)
	const left = head === "" ? [] : Str.split(":")(head)
	const right = tail === undefined || tail === "" ? [] : Str.split(":")(tail)
	const fill = Arr.makeBy(Math.max(0, 8 - left.length - right.length), () => "0")
	const groups = tail === undefined ? left : [...left, ...fill, ...right]
	return `${Arr.join(
		Arr.map(groups.slice(0, 4), (group) => Number.parseInt(group, 16).toString(16)),
		":",
	)}::/64`
}

export const retryAfterSeconds = (retryAfterMs: number): string => String(Math.ceil(retryAfterMs / 1000))

const tooManyAttempts = (retryAfterMs: number): Response =>
	new Response("too many failed attempts", {
		status: 429,
		headers: { "content-type": "text/plain", "retry-after": retryAfterSeconds(retryAfterMs) },
	})

/** Only same-site paths survive as a post-login destination. */
export const safeNextPath = (value: string | null | undefined): string =>
	// Printable ASCII only: browsers strip control characters from `Location` (`/\t/evil`
	// becomes `//evil`) and the header refuses non-Latin-1. `//` and `\` are refused too.
	value !== null && value !== undefined && /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/.test(value) ? value : "/"

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

/** The server-rendered sign-in page: no script, no external asset, so it works before any auth. */
export const loginPage = (options: {
	readonly error?: string
	readonly next: string
	readonly status?: number
}) =>
	new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Sign in · Maple Local</title>
<style>
:root{--bg:oklch(0.207 0.008 67);--fg:oklch(0.91 0.016 74);--card:oklch(0.224 0.009 75);--muted:oklch(0.603 0.023 72);--border:oklch(0.268 0.012 67);--input:oklch(0.33 0.015 72);--primary:oklch(0.714 0.154 59);--on-primary:oklch(0.207 0.008 67);--danger:oklch(0.654 0.176 30)}
@media (prefers-color-scheme: light){:root{--bg:oklch(1 0 0);--fg:oklch(0.141 0.005 285.823);--card:oklch(1 0 0);--muted:oklch(0.552 0.016 285.938);--border:oklch(0.92 0.004 286.32);--input:oklch(0.92 0.004 286.32);--primary:oklch(0.66 0.16 59);--on-primary:oklch(0.21 0.008 67);--danger:oklch(0.577 0.245 27.325)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
main{width:min(360px,calc(100vw - 32px));border:1px solid var(--border);background:var(--card);border-radius:8px;padding:24px}
h1{margin:0 0 4px;font-size:14px;font-weight:600}
h1 span{color:var(--muted);font-weight:400}
p{margin:0 0 20px;color:var(--muted)}
label{display:block;margin-bottom:6px}
input{width:100%;padding:8px 10px;border:1px solid var(--input);border-radius:6px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid var(--primary);outline-offset:1px}
button{margin-top:16px;width:100%;padding:8px 10px;border:0;border-radius:6px;background:var(--primary);color:var(--on-primary);font:inherit;font-weight:600;cursor:pointer}
.error{margin:12px 0 0;color:var(--danger)}
</style>
</head>
<body>
<main>
<h1>maple <span>local</span></h1>
<p>This server requires its access token.</p>
<form method="post" action="${LOGIN_ACTION_PATH}">
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
${options.error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`}
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`,
		{
			status: options.status ?? 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": LOGIN_CSP,
				"cache-control": "no-store",
				"x-frame-options": "DENY",
			},
		},
	)

import { networkInterfaces } from "node:os"
import { Cause, Duration, Effect, Layer, Option, Result, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { defaultLocalUrl, isLoopbackHostname, isRemoteHttps } from "@maple/local-server/local-address"
import { ACCESS_TOKEN_ENV } from "@maple/local-server/remote-auth"

const bare = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase()

/** Scheme and host of the configured target; any port, since a discovered server may not use the default. */
const targetOf = (value: string): { readonly protocol: string; readonly host: string } | undefined => {
	const url = Result.try(() => new URL(value))
	return Result.isSuccess(url)
		? { protocol: url.success.protocol, host: bare(url.success.hostname) }
		: undefined
}

/** This machine's own addresses: a server started with `--host <interface IP>` is found there. */
const ownAddresses = (): ReadonlySet<string> =>
	new Set(
		Object.values(networkInterfaces())
			.flatMap((entries) => entries ?? [])
			.map((entry) => bare(entry.address)),
	)

/**
 * Adds the access token to `/local/*` calls on the host the CLI targets (same
 * scheme, so an https target never gets it over http), or on this machine
 * (loopback or one of its own addresses). Other hosts never see it.
 */
export const withLocalAccessToken =
	(token: string | undefined, localUrl: string, localHosts: ReadonlySet<string> = ownAddresses()) =>
	(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
		if (token === undefined || request.headers.authorization !== undefined) return request
		const parsed = Result.try(() => new URL(request.url))
		if (Result.isFailure(parsed) || !parsed.success.pathname.startsWith("/local/")) return request
		const url = parsed.success
		const host = bare(url.hostname)
		const target = targetOf(localUrl)
		const isTarget = target !== undefined && host === target.host && url.protocol === target.protocol
		return isTarget || isLoopbackHostname(url.hostname) || localHosts.has(host)
			? HttpClientRequest.bearerToken(request, token)
			: request
	}

export const LOCAL_HEADERS_ENV = "MAPLE_LOCAL_HEADERS"

/**
 * `MAPLE_LOCAL_HEADERS`: comma-separated `name=value` pairs, values
 * percent-decoded, the same format as `OTEL_EXPORTER_OTLP_HEADERS`.
 */
export const parseLocalHeaders = (raw: string | undefined): Readonly<Record<string, string>> =>
	Object.fromEntries(
		(raw ?? "").split(",").flatMap((entry) => {
			const separator = entry.indexOf("=")
			const name = entry.slice(0, separator).trim().toLowerCase()
			if (separator < 0 || name === "") return []
			const value = entry.slice(separator + 1).trim()
			const decoded = Result.try(() => decodeURIComponent(value))
			return [[name, Result.isSuccess(decoded) ? decoded.success : value]]
		}),
	)

const originOf = (value: string): string | undefined => {
	const url = Result.try(() => new URL(value))
	return Result.isSuccess(url) ? url.success.origin : undefined
}

const isTargetRequest = (request: HttpClientRequest.HttpClientRequest, localUrl: string): boolean => {
	const target = originOf(localUrl)
	return target !== undefined && originOf(request.url) === target
}

/**
 * Adds `headers` to every request on the `MAPLE_LOCAL_URL` origin, on any path
 * (a proxy guards `/health` too). Headers the request already carries win, so
 * the content type and the access token cannot be replaced.
 */
export const withLocalHeaders =
	(headers: Readonly<Record<string, string>>, localUrl: string) =>
	(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
		if (!isTargetRequest(request, localUrl)) return request
		const missing = Object.entries(headers).filter(([name]) => request.headers[name] === undefined)
		return missing.length === 0
			? request
			: HttpClientRequest.setHeaders(request, Object.fromEntries(missing))
	}

/** True when the CLI should ask `cloudflared` for a Cloudflare Access token: no Access credential is set. */
export const wantsCloudflaredToken = (localUrl: string, headers: Readonly<Record<string, string>>): boolean =>
	isRemoteHttps(localUrl) &&
	headers["cf-access-token"] === undefined &&
	headers["cf-access-client-id"] === undefined

/** `cloudflared` answers from its token cache; anything slower is a prompt nobody will see. */
export const CLOUDFLARED_TIMEOUT = Duration.seconds(5)

const OUTCOME = "maple.cli.cloudflared.outcome"

/**
 * The Cloudflare Access token `cloudflared access login <origin>` cached, or
 * none when `cloudflared` is missing, has no token, fails or stalls. The span's
 * outcome (`found`, `no_token`, `timeout`, `unavailable`) says which.
 */
export const cloudflaredAccessToken = (
	origin: string,
	options: { readonly binary?: string; readonly timeout?: Duration.Input } = {},
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner
		const handle = yield* spawner.spawn(
			ChildProcess.make(options.binary ?? "cloudflared", ["access", "token", `-app=${origin}`], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			}),
		)
		const [exitCode, stdout] = yield* Effect.all(
			[handle.exitCode, Stream.mkString(Stream.decodeText(handle.stdout))],
			{ concurrency: "unbounded" },
		)
		const token = stdout.trim()
		if (exitCode === 0 && token !== "") {
			yield* Effect.annotateCurrentSpan(OUTCOME, "found")
			return Option.some(token)
		}
		yield* Effect.annotateCurrentSpan({
			[OUTCOME]: "no_token",
			"maple.cli.cloudflared.exit_code": exitCode,
		})
		return Option.none<string>()
	}).pipe(
		Effect.scoped,
		Effect.timeoutOrElse({
			duration: options.timeout ?? CLOUDFLARED_TIMEOUT,
			orElse: () => Effect.as(Effect.annotateCurrentSpan(OUTCOME, "timeout"), Option.none<string>()),
		}),
		Effect.catchCause((cause) =>
			Effect.logDebug("cloudflared access token failed", cause).pipe(
				Effect.andThen(
					Effect.annotateCurrentSpan({
						[OUTCOME]: "unavailable",
						"maple.cli.cloudflared.error": Cause.pretty(cause).split("\n")[0] ?? "",
					}),
				),
				Effect.as(Option.none<string>()),
			),
		),
		// Never the token or the host.
		Effect.withSpan("LocalAccess.cloudflaredToken", { kind: "client" }),
	)

export interface LocalAccessSettings {
	readonly localUrl: string
	readonly accessToken: string | undefined
	readonly headers: Readonly<Record<string, string>>
	/** Resolved at most once, on the first request to `localUrl`. */
	readonly cloudflaredToken: Effect.Effect<Option.Option<string>>
}

/**
 * The CLI's HttpClient for a local server, wherever it runs: signed in through
 * the access token, carrying the configured headers and, for an https server on
 * another host, the Cloudflare Access token. Redirects from the server are not
 * followed while it gets any of those, so they cannot leak to another origin,
 * and a proxy's sign-in page fails as a redirect instead of as HTML where JSON
 * was expected.
 */
export const localAccessClient =
	(settings: LocalAccessSettings) =>
	(client: HttpClient.HttpClient): Effect.Effect<HttpClient.HttpClient> =>
		Effect.gen(function* () {
			const { localUrl, headers } = settings
			const cloudflared = wantsCloudflaredToken(localUrl, headers)
				? yield* Effect.cached(settings.cloudflaredToken)
				: Effect.succeedNone
			// A followed redirect would carry the credentials added here to wherever
			// it points, so the target's redirects are never followed while any are.
			const noRedirects =
				isRemoteHttps(localUrl) ||
				Object.keys(headers).length > 0 ||
				settings.accessToken !== undefined
			return client.pipe(
				HttpClient.mapRequest(withLocalAccessToken(settings.accessToken, localUrl)),
				HttpClient.mapRequest(withLocalHeaders(headers, localUrl)),
				HttpClient.mapRequestEffect((request) =>
					// A request that already carries a token never waits on cloudflared.
					isTargetRequest(request, localUrl) && request.headers["cf-access-token"] === undefined
						? Effect.map(
								cloudflared,
								Option.match({
									onNone: () => request,
									onSome: (token) =>
										HttpClientRequest.setHeader(request, "cf-access-token", token),
								}),
							)
						: Effect.succeed(request),
				),
				HttpClient.transform((response, request) =>
					noRedirects && isTargetRequest(request, localUrl)
						? Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" })
						: response,
				),
			)
		})

/** The CLI's HttpClient, configured from `MAPLE_LOCAL_URL`, `MAPLE_LOCAL_ACCESS_TOKEN` and `MAPLE_LOCAL_HEADERS`. */
export const LocalAccessHttpClient = Layer.effect(
	HttpClient.HttpClient,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const spawner = yield* ChildProcessSpawner
		const localUrl = process.env.MAPLE_LOCAL_URL ?? defaultLocalUrl(process.env.MAPLE_LOCAL_BIND_HOST)
		return yield* localAccessClient({
			localUrl,
			accessToken: process.env[ACCESS_TOKEN_ENV]?.trim() || undefined,
			headers: parseLocalHeaders(process.env[LOCAL_HEADERS_ENV]),
			// Only asked for when `localUrl` parses (`wantsCloudflaredToken`).
			cloudflaredToken: cloudflaredAccessToken(originOf(localUrl) ?? localUrl).pipe(
				Effect.provideService(ChildProcessSpawner, spawner),
			),
		})(client)
	}),
)

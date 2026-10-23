import { networkInterfaces } from "node:os"
import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { defaultLocalUrl, isLoopbackHostname } from "../lib/local-address"
import { ACCESS_TOKEN_ENV } from "../server/remote-auth"

const bare = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase()

const hostnameOf = (value: string): string | undefined => {
	const url = Result.try(() => new URL(value))
	return Result.isSuccess(url) ? bare(url.success.hostname) : undefined
}

/** This machine's own addresses: a server started with `--host <interface IP>` is found there. */
const ownAddresses = (): ReadonlySet<string> =>
	new Set(
		Object.values(networkInterfaces())
			.flatMap((entries) => entries ?? [])
			.map((entry) => bare(entry.address)),
	)

/**
 * Adds the access token to `/local/*` calls on the host the CLI targets, or on
 * this machine (loopback or one of its own addresses), at any port since a
 * discovered server may not use the default. Other hosts never see it.
 */
export const withLocalAccessToken =
	(token: string | undefined, localUrl: string, localHosts: ReadonlySet<string> = ownAddresses()) =>
	(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
		if (token === undefined || request.headers.authorization !== undefined) return request
		const parsed = Result.try(() => new URL(request.url))
		if (Result.isFailure(parsed) || !parsed.success.pathname.startsWith("/local/")) return request
		const url = parsed.success
		const host = bare(url.hostname)
		return host === hostnameOf(localUrl) || isLoopbackHostname(url.hostname) || localHosts.has(host)
			? HttpClientRequest.bearerToken(request, token)
			: request
	}

/** The CLI's HttpClient, signed in to a self-hosted server through `MAPLE_LOCAL_ACCESS_TOKEN`. */
export const LocalAccessHttpClient = Layer.effect(
	HttpClient.HttpClient,
	Effect.map(HttpClient.HttpClient, (client) =>
		HttpClient.mapRequest(
			client,
			withLocalAccessToken(
				process.env[ACCESS_TOKEN_ENV]?.trim() || undefined,
				process.env.MAPLE_LOCAL_URL ?? defaultLocalUrl(process.env.MAPLE_LOCAL_BIND_HOST),
			),
		),
	),
)

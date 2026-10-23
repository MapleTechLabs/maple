import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { defaultLocalUrl, isLoopbackHostname } from "../lib/local-address"
import { ACCESS_TOKEN_ENV } from "../server/remote-auth"

const hostnameOf = (value: string): string | undefined => {
	const url = Result.try(() => new URL(value))
	return Result.isSuccess(url) ? url.success.hostname : undefined
}

/**
 * Adds the access token to `/local/*` calls on the host the CLI targets (any port,
 * since a discovered server may not use the default) or on loopback. A process
 * squatting a loopback port could read it; anything farther away never sees it.
 */
export const withLocalAccessToken =
	(token: string | undefined, localUrl: string) =>
	(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
		if (token === undefined || request.headers.authorization !== undefined) return request
		const parsed = Result.try(() => new URL(request.url))
		if (Result.isFailure(parsed) || !parsed.success.pathname.startsWith("/local/")) return request
		const url = parsed.success
		return url.hostname === hostnameOf(localUrl) || isLoopbackHostname(url.hostname)
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

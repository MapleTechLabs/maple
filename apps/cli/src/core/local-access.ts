import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { isLoopbackHostname } from "../lib/local-address"
import { ACCESS_TOKEN_ENV } from "../server/remote-auth"

const originOf = (value: string | undefined): string | undefined => {
	const url = value === undefined ? undefined : Result.try(() => new URL(value))
	return url !== undefined && Result.isSuccess(url) ? url.success.origin : undefined
}

/**
 * Adds the access token to `/local/*` calls on the server the CLI targets: the
 * `MAPLE_LOCAL_URL` origin, or a loopback server. Nothing else ever sees it.
 */
export const withLocalAccessToken =
	(token: string | undefined, localUrl: string | undefined) =>
	(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
		if (token === undefined || request.headers.authorization !== undefined) return request
		const parsed = Result.try(() => new URL(request.url))
		if (Result.isFailure(parsed) || !parsed.success.pathname.startsWith("/local/")) return request
		const url = parsed.success
		return url.origin === originOf(localUrl) || isLoopbackHostname(url.hostname)
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
				process.env.MAPLE_LOCAL_URL,
			),
		),
	),
)

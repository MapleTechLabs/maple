import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ACCESS_TOKEN_ENV } from "../server/remote-auth"

/** Adds the access token to calls on a Maple Local server's `/local/*` routes, and nothing else. */
export const withLocalAccessToken =
	(token: string | undefined) =>
	(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
		if (token === undefined || request.headers.authorization !== undefined) return request
		const url = Result.try(() => new URL(request.url))
		return Result.isSuccess(url) && url.success.pathname.startsWith("/local/")
			? HttpClientRequest.bearerToken(request, token)
			: request
	}

/** The CLI's HttpClient, signed in to a self-hosted server through `MAPLE_LOCAL_ACCESS_TOKEN`. */
export const LocalAccessHttpClient = Layer.effect(
	HttpClient.HttpClient,
	Effect.map(HttpClient.HttpClient, (client) =>
		HttpClient.mapRequest(
			client,
			withLocalAccessToken(process.env[ACCESS_TOKEN_ENV]?.trim() || undefined),
		),
	),
)

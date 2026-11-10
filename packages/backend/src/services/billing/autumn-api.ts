import { HttpClientRequest } from "effect/http"

/** Autumn's source-controlled REST compatibility contract. */
export const AUTUMN_API_VERSION = "2.3.0"

/** Canonical RPC-style route for recording balance usage. */
export const AUTUMN_TRACK_PATH = "/v1/balances.track"

/** Records one model's token usage against the org's AI credit system, priced by Autumn. */
export const AUTUMN_TRACK_TOKENS_PATH = "/v1/balances.track_tokens"

export const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com"

/**
 * A POST to one Autumn route as every Maple caller sends it: the secret key as bearer and the pinned
 * `x-api-version`. The billing routes (`autumn-http.ts`) and the usage tracker both build on it.
 */
export const autumnPost = (apiUrl: string, secretKey: string, path: string) =>
	HttpClientRequest.post(`${apiUrl}${path}`, {
		headers: { Authorization: `Bearer ${secretKey}`, "x-api-version": AUTUMN_API_VERSION },
	})

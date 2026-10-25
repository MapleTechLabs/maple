import { MapleAiApi, MapleApi, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { isBillingRequest, transformMapleApiClient } from "../lib/services/common/api-client-transform"
import { apiBaseUrl } from "../lib/services/common/api-base-url"
import { withRequestTimeout } from "../lib/services/common/http-client"
import { withUnauthorizedResign } from "../lib/services/common/retry-policy"
import { Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { MapleAuthApi } from "./auth-api"
import { SessionBearer } from "./session-bearer"

/**
 * The API HTTP client: requests to the API carry the session bearer, every request has
 * the same 45 s deadline, and billing reads that 401 are resent with a fresh bearer.
 */
const MapleHttpClientLive = Layer.effect(
	HttpClient.HttpClient,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const bearer = yield* SessionBearer
		const authorize = (request: HttpClientRequest.HttpClientRequest) =>
			request.url.startsWith(apiBaseUrl) && request.headers.authorization === undefined
				? Effect.map(
						bearer.token,
						Option.match({
							onNone: () => request,
							onSome: (token) => HttpClientRequest.bearerToken(request, token),
						}),
					)
				: Effect.succeed(request)
		// The base URL is prepended here, not by HttpApiClient: its `baseUrl` is applied after this
		// client's request mapping, so `authorize` would only ever see relative URLs.
		const absolute = HttpClient.mapRequest(client, HttpClientRequest.prependUrl(apiBaseUrl))
		return withUnauthorizedResign(withRequestTimeout(HttpClient.mapRequestEffect(absolute, authorize)), {
			shouldRetry: (request) => request.url.startsWith(apiBaseUrl) && isBillingRequest(request),
			freshToken: bearer.freshToken,
		})
	}),
).pipe(Layer.provide([FetchHttpClient.layer, SessionBearer.layer]))

const clientOptions = { transformClient: transformMapleApiClient }
const makeMapleApi = HttpApiClient.make(MapleApi, clientOptions)
const makeInternalApi = HttpApiClient.make(MapleInternalApi, clientOptions)
const makeApiV2 = HttpApiClient.make(MapleApiV2, clientOptions)
const makeAiApi = HttpApiClient.make(MapleAiApi, clientOptions)

/** `MapleApiAtomClient`: auth, billing catalog, email at `/api`. */
export class MapleApiClient extends Context.Service<MapleApiClient, Effect.Success<typeof makeMapleApi>>()(
	"@maple/web/MapleApiClient",
) {
	static readonly layer = Layer.effect(this, makeMapleApi).pipe(Layer.provide(MapleHttpClientLive))
}

/** `MapleInternalAtomClient`: the dashboard's private transport at `/internal`. */
export class MapleInternalApiClient extends Context.Service<
	MapleInternalApiClient,
	Effect.Success<typeof makeInternalApi>
>()("@maple/web/MapleInternalApiClient") {
	static readonly layer = Layer.effect(this, makeInternalApi).pipe(Layer.provide(MapleHttpClientLive))
}

/** `MapleApiV2AtomClient`: the public v2 API. */
export class MapleApiV2Client extends Context.Service<MapleApiV2Client, Effect.Success<typeof makeApiV2>>()(
	"@maple/web/MapleApiV2Client",
) {
	static readonly layer = Layer.effect(this, makeApiV2).pipe(Layer.provide(MapleHttpClientLive))
}

/** `MapleAiAtomClient`: chat and AI endpoints. */
export class MapleAiClient extends Context.Service<MapleAiClient, Effect.Success<typeof makeAiApi>>()(
	"@maple/web/MapleAiClient",
) {
	static readonly layer = Layer.effect(this, makeAiApi).pipe(Layer.provide(MapleHttpClientLive))
}

/**
 * `mapleSyncFetch`: requests to the Electric shape proxy (`apps/electric-sync`) carry the session
 * bearer so the proxy resolves the tenant. No request timeout: live shape requests long-poll.
 */
export class MapleSyncHttpClient extends Context.Service<MapleSyncHttpClient, HttpClient.HttpClient>()(
	"@maple/web/MapleSyncHttpClient",
) {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient
			const bearer = yield* SessionBearer
			return HttpClient.mapRequestEffect(client, (request) =>
				Effect.map(
					bearer.token,
					Option.match({
						onNone: () => request,
						onSome: (token) => HttpClientRequest.bearerToken(request, token),
					}),
				),
			)
		}),
	).pipe(Layer.provide([FetchHttpClient.layer, SessionBearer.layer]))
}

/** Every HTTP client; `resources.ts` adds the data layer's resources on top. */
export const ApiClientsLive = Layer.mergeAll(
	MapleAuthApi.layer,
	// Plain same-origin requests (`/version.json`).
	FetchHttpClient.layer,
	MapleSyncHttpClient.layer,
	MapleApiClient.layer,
	MapleInternalApiClient.layer,
	MapleApiV2Client.layer,
	MapleAiClient.layer,
)

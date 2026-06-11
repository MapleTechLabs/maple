import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { apiBaseUrl } from "./api-base-url"
import { MapleFetchHttpClientLive } from "./http-client"

export class MapleApiAtomClient extends AtomHttpApi.Service<MapleApiAtomClient>()(
	"@maple/web/services/common/MapleApiAtomClient",
	{
		api: MapleApi,
		httpClient: MapleFetchHttpClientLive,
		baseUrl: apiBaseUrl,
		// `peer.service` on the outbound `http.client` span draws the
		// maple-web → maple-api edge on the service map. Annotate HERE rather than
		// by rewrapping MapleFetchHttpClientLive: that layer must stay literally
		// `FetchHttpClient.layer` + mapleFetch so the memoMap priming in
		// registry.ts keeps the JWT-injecting fetch (see the registry comment —
		// rewrapping it ships every API request without auth, mass 401s).
		transformClient: (client) =>
			client.pipe(
				(self) =>
					HttpClient.transform(self, (effect, request) =>
						request.url.startsWith(apiBaseUrl)
							? Effect.annotateSpans(effect, "peer.service", "maple-api")
							: effect,
					),
				HttpClient.retry({
					times: 3,
					while: (error) => {
						if (HttpClientError.isHttpClientError(error)) {
							const status = error.response?.status
							// Only retry on 500/502/503 — not 504 (timeout) or undefined (network failure)
							return status !== undefined && status >= 500 && status < 600 && status !== 504
						}

						return false
					},
				}),
			),
	},
) {}

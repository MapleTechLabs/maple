import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleAiApi } from "@maple/domain/http"
import { apiBaseUrl } from "./api-base-url"
import { transformMapleApiClient } from "./api-client-transform"
import { MapleFetchHttpClientLive } from "./http-client"

/**
 * Client for the agent Worker's private transport.
 *
 * Same origin and same `apiBaseUrl` as the internal client, because the api
 * still owns the hostname and forwards these paths to `maple-ai` over a service
 * binding — the split is which Worker answers, not which host the dashboard
 * calls. That also means `mapleFetch`'s URL scoping still attaches the Clerk
 * JWT, and `MapleFetchHttpClientLive` is passed through untouched for the reason
 * spelled out in `internal-atom-client.ts`.
 *
 * Separate from `MapleInternalAtomClient` because an `HttpApi` must be
 * implemented in full by whoever builds it, so the chat group could not stay in
 * `MapleInternalApi` once its handlers moved Workers.
 */
export class MapleAiAtomClient extends AtomHttpApi.Service<MapleAiAtomClient>()(
	"@maple/web/services/common/MapleAiAtomClient",
	{
		api: MapleAiApi,
		httpClient: MapleFetchHttpClientLive,
		baseUrl: apiBaseUrl,
		transformClient: transformMapleApiClient,
	},
) {}

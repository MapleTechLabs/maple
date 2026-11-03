import { Effect, String as Str } from "effect"
import { HttpClient, type HttpClientRequest } from "effect/http"
import { apiBaseUrl } from "./api-base-url"
import { withMapleRetryPolicy } from "./retry-policy"

/**
 * Billing reads can race Clerk's token-settle window and briefly leave without a bearer
 * token, so their 401s are re-signed and resent (`withUnauthorizedResign` in `api-clients.ts`).
 * Both prefixes are load-bearing: authenticated operations live at `/internal/billing`, the
 * unauthenticated plan catalog at `/api/billing`. Genuine 401s elsewhere fail fast.
 */
export const isBillingRequest = (request: HttpClientRequest.HttpClientRequest): boolean =>
	Str.includes("/internal/billing/")(request.url) || Str.includes("/api/billing/")(request.url)

export const transformMapleApiClient = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
): HttpClient.HttpClient.With<E, R> =>
	client.pipe(
		(self) =>
			HttpClient.transform(self, (effect, request) =>
				Str.startsWith(apiBaseUrl)(request.url)
					? Effect.annotateSpans(effect, "peer.service", "maple-api")
					: effect,
			),
		withMapleRetryPolicy,
	)

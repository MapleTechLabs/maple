import { Effect, String as Str } from "effect"
import { HttpClient, type HttpClientRequest } from "effect/http"
import { apiBaseUrl } from "./api-base-url"
import { isIdempotentRequest, withMapleRetryPolicy } from "./retry-policy"

/**
 * Billing reads can race Clerk's token-settle window and briefly leave without a bearer
 * token, so their 401s are re-signed and resent (`withUnauthorizedResign` in `api-clients.ts`).
 * Both prefixes are load-bearing: authenticated operations live at `/internal/billing`, the
 * unauthenticated plan catalog at `/api/billing`. Genuine 401s elsewhere fail fast.
 */
export const isBillingRequest = (request: HttpClientRequest.HttpClientRequest): boolean =>
	Str.includes("/internal/billing/")(request.url) || Str.includes("/api/billing/")(request.url)

const ORGANIZATION_CREATE_PATH = /\/internal\/organizations\/?(?:[?#]|$)/

/**
 * Creating the first organization runs right after sign-up, inside the same token-settle window.
 * A 401 is refused at the auth gate before anything is written, so resending it cannot create twice.
 */
const isOrganizationCreateRequest = (request: HttpClientRequest.HttpClientRequest): boolean =>
	request.method === "POST" && ORGANIZATION_CREATE_PATH.test(request.url)

/** The API requests whose 401 is resent with a fresh bearer: billing reads and org creation. */
export const isResignedOnUnauthorized = (request: HttpClientRequest.HttpClientRequest): boolean =>
	(isIdempotentRequest(request) && isBillingRequest(request)) || isOrganizationCreateRequest(request)

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

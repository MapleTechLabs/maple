import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Effect } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { PLANETSCALE_CALLBACK_PATH } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { SUPABASE_CALLBACK_PATH } from "@maple/backend/services/auth/SupabaseOAuthService"

export const HAZEL_CALLBACK_PATH = "/api/integrations/hazel/callback"
export const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"
export const CLOUDFLARE_CALLBACK_PATH = "/api/integrations/cloudflare/callback"

/** How the dashboard finishes a forwarded callback (`IntegrationsSearch.callback`). */
export type DashboardCallbackKind = "oauth" | "chat-install" | "chat-identity"

/**
 * Where a provider callback goes: the dashboard's integrations page, which finishes the flow as
 * the signed-in user (`oauthComplete` / `chatComplete`). The provider's query rides in the
 * fragment, so the authorization code never reaches a server log, a `Referer`, or the web Worker.
 */
export const dashboardCallbackUrl = (
	appBaseUrl: string,
	integration: string,
	kind: DashboardCallbackKind,
	query: string,
): string => {
	const search = new URLSearchParams({ integration, callback: kind })
	return `${appBaseUrl.replace(/\/$/, "")}/integrations?${search.toString()}#${query}`
}

/** The raw query string of a callback request, without its `?`. */
export const callbackQueryOf = (req: HttpServerRequest.HttpServerRequest): string => {
	const index = req.url.indexOf("?")
	return index === -1 ? "" : req.url.slice(index + 1)
}

/**
 * A public callback completes nothing. The authorize URL behind it is transferable, so the
 * browser that lands here proves nothing about which Maple user started the flow; only the
 * dashboard's session does. `no-store` and `no-referrer` keep the forwarded code out of caches
 * and out of the next page's `Referer`.
 */
export const forwardToDashboard = (location: string) =>
	HttpServerResponse.redirect(location, {
		status: 302,
		headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
	})

const PROVIDER_CALLBACKS = [
	{ path: HAZEL_CALLBACK_PATH, provider: "hazel" },
	{ path: GITHUB_CALLBACK_PATH, provider: "github" },
	{ path: CLOUDFLARE_CALLBACK_PATH, provider: "cloudflare" },
	{ path: PLANETSCALE_CALLBACK_PATH, provider: "planetscale" },
	{ path: SUPABASE_CALLBACK_PATH, provider: "supabase" },
] as const

export const IntegrationsCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env

		yield* Effect.forEach(PROVIDER_CALLBACKS, ({ path, provider }) =>
			router.add(
				"GET",
				path,
				// Server-kind with the HTTP identity attributes stamped by hand: the auto server span
				// is suppressed for OAuth callbacks (it would record the authorization `code` and the
				// connect `state` in `url.full` / `url.query`, see ApiObservabilityLive), so this span
				// is the callback's only trace root. It never carries the query string.
				Effect.fn("IntegrationsCallbackRouter.oauthCallback", {
					kind: "server",
					attributes: {
						"http.route": path,
						"http.request.method": "GET",
						"maple.integration.provider": provider,
					},
				})(function* (req: HttpServerRequest.HttpServerRequest) {
					yield* Effect.annotateCurrentSpan({ "http.response.status_code": 302 })
					return forwardToDashboard(
						dashboardCallbackUrl(env.MAPLE_APP_BASE_URL, provider, "oauth", callbackQueryOf(req)),
					)
				}),
			),
		)
	}),
)

import { Effect, Array as Arr, String as Str } from "effect"
import { apiProxyPath } from "./api-proxy"
import { forwardToApi } from "./api-proxy-forward"
import { OG_IMAGE_PREFIX, ogIdFromPath, shareTokenFromPath } from "./og/share-links"
import { CHART_KINDS, chartRequestFromPath, renderChartImage } from "./og/chart-image"
import { fetchShareOgMeta, renderShareOgImage, shareOgMetaRewriter } from "./og/share-preview"
import { apiTarget, type ApiTarget, type WebWorkerEnv } from "./worker-env"
import { APP_DOCUMENT_HEADERS, documentHeaders } from "./document-headers"

/** HTML only. A script or stylesheet is not framed, and `frame-ancestors` on one means nothing. */
const isHtmlResponse = (response: Response): boolean =>
	Str.includes("text/html")(response.headers.get("content-type") ?? "")

const applyDocumentSecurityHeaders = (response: Response, pathname: string): Response => {
	if (!isHtmlResponse(response)) return response

	// Rebuilt field by field: a `Response` works as a `ResponseInit` (the spec
	// reads status/statusText/headers off it), but a spread does not — those are
	// prototype getters, so `{ ...response }` is an empty object and the result
	// would silently become a 200 with no headers at all.
	const headers = new Headers(response.headers)

	// The asset this document came from may carry the app set (the shell fetched at "/"), so a
	// header the path does not get is removed, not left: a share page must stay frameable.
	Arr.forEach(APP_DOCUMENT_HEADERS, ([name]) => headers.delete(name))
	Arr.forEach(documentHeaders(pathname), ([name, value]) => headers.set(name, value))

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * Inline a share link's own `og:*` tags, when it has any.
 *
 * Applied to every viewer, not only to crawlers: sniffing user agents to serve
 * different HTML is cloaking, and the tags change nothing for a human — the app
 * replaces the head as soon as it boots.
 */
const applyShareOgMeta = async (
	response: Response,
	url: URL,
	api: ApiTarget | undefined,
): Promise<Response> => {
	const token = shareTokenFromPath(url.pathname)
	if (api === undefined || token === undefined || !isHtmlResponse(response)) return response

	const meta = await fetchShareOgMeta(api, token)
	// No meta means an org-only link, a dead one, or an API that did not answer.
	// All three keep the generic card, and none of them is worth a broken page.
	return meta === undefined ? response : shareOgMetaRewriter(meta, url.origin).transform(response)
}

const IMAGE_PREFIXES = [OG_IMAGE_PREFIX, ...Arr.map(CHART_KINDS, (kind) => kind.pathPrefix)]

const isImagePath = (pathname: string): boolean =>
	Str.endsWith(".png")(pathname) && Arr.some(IMAGE_PREFIXES, (prefix) => Str.startsWith(prefix)(pathname))

/** One request against the built SPA: OG images, the share preview, security headers, the shell fallback. */
export const handleRequest = async (
	request: Request,
	env: WebWorkerEnv,
	runTraced: (effect: Effect.Effect<Response>) => Promise<Response> = Effect.runPromise,
): Promise<Response> => {
	const url = new URL(request.url)
	const api = apiTarget(env)

	const apiPath = apiProxyPath(url.pathname)
	if (apiPath !== undefined) {
		// Binding only: a public `fetch` would replace the browser's `cf-connecting-ip`.
		const proxyTarget = env.API === undefined ? undefined : api
		return runTraced(forwardToApi(request, url, proxyTarget, apiPath))
	}

	// Ahead of the assets lookup: this path has no asset behind it, and the
	// 404 the assets layer returns for it would fall through to the SPA shell.
	const ogId = ogIdFromPath(url.pathname)
	if (ogId !== undefined) {
		return api === undefined
			? new Response(null, { status: 404 })
			: renderShareOgImage(api, ogId, env.ASSETS)
	}

	// Also ahead of the assets lookup, and for the same reason: the SPA shell
	// answers `/alerts/…` and `/chat/chart/…` with HTML, which in an `<img>` slot is no
	// 404 anyone could diagnose.
	const chart = chartRequestFromPath(url.pathname)
	if (chart !== undefined) {
		return api === undefined
			? new Response(null, { status: 404 })
			: renderChartImage(api, chart, env.ASSETS)
	}

	// An image path whose id did not parse (a lone `%`, a nested segment) is still an image path.
	if (isImagePath(url.pathname)) return new Response(null, { status: 404 })

	const assetResponse = await env.ASSETS.fetch(request)
	if (assetResponse.status !== 404) {
		// `/version.json` is the one asset whose whole job is to be stale-free:
		// clients poll it to learn a newer bundle is deployed. Served from any
		// cache it would report the deploy the tab is already running, which is
		// exactly the answer that makes the check useless.
		if (url.pathname === "/version.json") {
			const response = new Response(assetResponse.body, assetResponse)
			response.headers.set("Cache-Control", "no-store, must-revalidate")
			return response
		}
		// `/` resolves to a real asset and returns here rather than through the
		// fallback below, so the headers have to be applied on both paths — this
		// one is the app's own front door.
		//
		// `/share/<token>` also lands here, not in the fallback: with
		// `not_found_handling: single-page-application` the assets layer answers
		// unknown paths with the shell itself, at status 200. The share preview
		// therefore has to be applied on this branch too — putting it only on
		// the fallback below silently disables it in every deployment.
		return applyShareOgMeta(applyDocumentSecurityHeaders(assetResponse, url.pathname), url, api)
	}

	// Fetch "/" rather than "/index.html": the assets layer's
	// auto-trailing-slash handling answers explicit /index.html requests
	// with a 307 to "/", which would bounce deep links to the root.
	//
	// Every SPA route lands here, which is what makes this the one place the
	// document's security headers can be set from the requested path.
	const document = await env.ASSETS.fetch(new Request(new URL("/", url), request))
	// Reached when the assets layer 404s rather than serving the shell — a
	// deployment without SPA not-found handling, or a request it declines.
	return applyShareOgMeta(applyDocumentSecurityHeaders(document, url.pathname), url, api)
}

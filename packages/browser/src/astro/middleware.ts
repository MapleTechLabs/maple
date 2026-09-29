// `@maple-dev/browser/astro/middleware`: route names in the HTML, and a span
// per on-demand render.
//
// Every page's HTML gets its route template on `<html data-route>`, for the
// browser's span names: at build time for prerendered pages, per request for
// the rest. An on-demand request also runs in an `ssr <route>` span, and its
// HTML response hands that span's context to the browser in `Server-Timing`,
// so the page load joins the server's trace. Depends on `@opentelemetry/api`
// only: safe in Node, Workers and other server runtimes.
import { SpanStatusCode, trace } from "@opentelemetry/api"
import type { APIContext, MiddlewareHandler } from "astro"
import { runTraced } from "../failures"
import { serverTiming } from "../server"
import { SDK_NAME, SDK_VERSION } from "../version"
import { stampRoute } from "./html"

/**
 * Astro middleware: `ssr <route>` spans for on-demand requests, and the route template on each page's `<html>`.
 * Added by the `maple()` integration; export it from `src/middleware.ts` (first in `sequence()`) to wire it yourself.
 */
export const onRequest: MiddlewareHandler = (ctx, next): Promise<Response> => {
	// Astro 4 and older: no route to name anything after
	if (!ctx.routePattern) return next()
	// Prerendered pages run this at build time: no request to trace
	if (ctx.isPrerendered) return next().then((response) => withRoute(response, ctx.routePattern))
	return trace.getTracer(SDK_NAME, SDK_VERSION).startActiveSpan(`ssr ${ctx.routePattern}`, (span) =>
		runTraced(
			span,
			async () => {
				const response = await next()
				if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
				const timing = replayed(ctx, response.headers) ? undefined : serverTiming()
				return withRoute(response, ctx.routePattern, timing)
			},
			{},
		),
	)
}

/** `CDN-Cache-Control` and its vendor variants (`Vercel-CDN-Cache-Control`, ...), `Surrogate-Control`. */
const CDN_CACHE_HEADER = /^(?:surrogate-control|(?:[\w-]+-)?cdn-cache-control)$/
const CACHEABLE = /\b(?:public|s-maxage|max-age=0*[1-9])/i
const NOT_STORED = /\b(?:no-store|private)\b/i

/**
 * Whether others may get this same response from a cache, and would all join this request's
 * trace: Astro's route cache stores it (Astro 7), or its headers let a cache like a CDN store it.
 */
function replayed(ctx: APIContext, headers: Headers): boolean {
	const cache = ctx.cache?.options
	if (cache?.maxAge || cache?.swr) return true
	for (const [name, value] of headers) {
		if (NOT_STORED.test(value)) continue
		if (CDN_CACHE_HEADER.test(name) || (name === "cache-control" && CACHEABLE.test(value))) return true
	}
	return false
}

/** The HTML response with the route on its `<html>` element, and the `Server-Timing` entry if any. */
function withRoute(response: Response, route: string, timing?: string): Response {
	if (!response.body || !response.headers.get("content-type")?.startsWith("text/html")) return response
	// A copy: headers from `fetch()` can't be changed
	const headers = new Headers(response.headers)
	if (timing) headers.append("server-timing", timing)
	let body = response.body
	// Compressed by other middleware: nothing to read
	if (!headers.has("content-encoding")) {
		body = body.pipeThrough(stampRoute(route))
		headers.delete("content-length")
	}
	return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

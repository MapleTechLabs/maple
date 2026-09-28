// `@maple-dev/browser/nextjs/server`: joins the page load to the server render.
//
// Pages can't set response headers, but `proxy.ts` (`middleware.ts` before
// Next.js 16) runs before the render, inside Next.js's `middleware` span. The
// proxy hands that span's context to the render in the `traceparent` request
// header, which Next.js reads when it starts the render's root span, and to the
// browser in `Server-Timing`, which the `pageload` span reads. Depends on
// `@opentelemetry/api` and `next/server` only: safe in the edge runtime.
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server"
import { activeTraceparent } from "../traceparent"

type ProxyResult = Response | null | undefined | void
type ProxyFunction = (request: NextRequest, event: NextFetchEvent) => ProxyResult | Promise<ProxyResult>

/** How `NextResponse.next({ request: { headers } })` tells Next.js which request headers the render sees. */
const OVERRIDE_HEADERS = "x-middleware-override-headers"
const REQUEST_HEADER = "x-middleware-request-"

/**
 * Wrap your proxy (or middleware), or create one: `export const proxy = withMapleProxy()`.
 * Joins the page load to the server render's trace. Your proxy's responses pass through.
 */
export function withMapleProxy(proxy?: ProxyFunction): ProxyFunction {
	return async (request, event) => {
		// Client navigations already carry the browser's traceparent: replacing it
		// would cut the render off from the browser `fetch` span that made it
		const traceparent = request.headers.has("traceparent") ? undefined : activeTraceparent()
		const response = await proxy?.(request, event)
		if (!traceparent) return response
		const result = response ?? NextResponse.next()
		if (!rendersHere(result, request)) return response
		forwardToRender(result, request, traceparent)
		result.headers.append("server-timing", `traceparent;desc="${traceparent}"`)
		return result
	}
}

/**
 * Whether the request goes on to a render in this app: `next()`, or a rewrite
 * to the same origin. A redirect or your own response has no render to join,
 * and a rewrite elsewhere must not leak the trace id to another origin.
 */
function rendersHere(response: Response, request: NextRequest): boolean {
	if (response.headers.has("x-middleware-next")) return true
	const rewrite = response.headers.get("x-middleware-rewrite")
	return rewrite !== null && new URL(rewrite, request.url).origin === new URL(request.url).origin
}

/** Add `traceparent` to the request headers the render sees, keeping the ones your proxy set. */
function forwardToRender(response: Response, request: NextRequest, traceparent: string): void {
	const overridden = response.headers.get(OVERRIDE_HEADERS)
	// Without the list, the render sees the request's own headers: list them all,
	// as `NextResponse.next({ request: { headers } })` does
	const names = overridden === null ? [...request.headers.keys()] : overridden.split(",")
	if (overridden === null) {
		for (const [name, value] of request.headers) response.headers.set(REQUEST_HEADER + name, value)
	}
	if (!names.includes("traceparent")) names.push("traceparent")
	response.headers.set(OVERRIDE_HEADERS, names.join(","))
	response.headers.set(`${REQUEST_HEADER}traceparent`, traceparent)
}

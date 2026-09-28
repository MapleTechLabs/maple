// `@maple-dev/browser/nextjs/server`: joins the page load to the server render.
//
// Pages can't set response headers, but `proxy.ts` (`middleware.ts` before
// Next.js 16) runs before the render, inside Next.js's `middleware` span. The
// proxy hands that span's context to the render in the `traceparent` request
// header, which Next.js reads when it starts the render's root span, and to the
// browser in `Server-Timing`, which the `pageload` span reads. Depends on
// `@opentelemetry/api` and `next/server` only: safe in the edge runtime.
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server"
import { activeTraceparent, serverTimingEntry } from "../traceparent"

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
		const traceparent = activeTraceparent()
		const response = await proxy?.(request, event)
		if (!traceparent || (response && !rendersHere(response, request))) return response
		// A traceparent the render already receives stays, and the render joins it on
		// its own. A client navigation's RSC request carries the browser's (replacing
		// it would cut the render off from the `fetch` span that made it) and needs
		// nothing back. A page load can carry one a load balancer added, whose trace
		// the middleware span is in too: the browser still joins through the header.
		const carried = renderReceivesTraceparent(response, request)
		if (carried && request.headers.get("sec-fetch-dest") !== "document") return response
		const result =
			response ?? NextResponse.next(carried ? undefined : withTraceparent(request, traceparent))
		if (response && !carried) forwardToRender(response, request, traceparent)
		result.headers.append("server-timing", serverTimingEntry(traceparent))
		return result
	}
}

/** The request's own `traceparent` reaches the render, unless your proxy's `next({ request })` left it out. */
function renderReceivesTraceparent(response: ProxyResult, request: NextRequest): boolean {
	const overridden = response?.headers.get(OVERRIDE_HEADERS)
	return typeof overridden === "string"
		? overridden.split(",").includes("traceparent")
		: request.headers.has("traceparent")
}

/** `next()` options that add `traceparent` to the request headers the render sees. */
function withTraceparent(request: NextRequest, traceparent: string) {
	const headers = new Headers(request.headers)
	headers.set("traceparent", traceparent)
	return { request: { headers } }
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

/**
 * `withTraceparent` for a response your proxy made, keeping the request headers
 * it set: the headers `NextResponse.next({ request: { headers } })` writes,
 * extended the way Next.js extends them with its own router headers.
 */
function forwardToRender(response: Response, request: NextRequest, traceparent: string): void {
	const overridden = response.headers.get(OVERRIDE_HEADERS)
	// Without the list, the render sees the request's own headers: list them all
	const names = overridden === null ? [...request.headers.keys()] : overridden.split(",")
	if (overridden === null) {
		for (const [name, value] of request.headers) response.headers.set(REQUEST_HEADER + name, value)
	}
	if (!names.includes("traceparent")) names.push("traceparent")
	response.headers.set(OVERRIDE_HEADERS, names.join(","))
	response.headers.set(`${REQUEST_HEADER}traceparent`, traceparent)
}

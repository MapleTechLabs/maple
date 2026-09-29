// `@maple-dev/browser/tanstack/server`: TanStack Start's server entry.
//
// Start runs a page's loaders before it calls the handler callback, so the span
// they share opens around the whole request, in the server entry's `fetch`. The
// callback then knows the route: it names that span and hands its context to
// the browser in `Server-Timing`, which the `pageload` span reads. Spans go
// through the server's global tracer; without server OpenTelemetry, both
// wrappers only pass through.
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import type { AnyRouter } from "@tanstack/react-router"
import { recordFailure } from "../failures"
import { serverTiming } from "../server"
import { parseTraceparent } from "../traceparent"
import { SDK_NAME, SDK_VERSION } from "../version"
import { routeTemplate } from "./route"

/**
 * Wrap the server entry's `fetch`: a span per request, so a page's server loaders and its render share a trace.
 * `createServerEntry({ fetch: traceRequests(createStartHandler(traceRender(defaultStreamHandler))) })`
 */
export function traceRequests<Args extends unknown[]>(
	fetch: (request: Request, ...args: Args) => Response | Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
	return (request, ...args) => {
		// Inside a span the server's HTTP instrumentation opened, this one is part
		// of that request. Otherwise it is the request, and joins a trace the
		// request carries, like a server function called from the browser.
		const active = context.active()
		const inRequest = trace.getSpan(active) !== undefined
		const carried = parseTraceparent(request.headers.get("traceparent") ?? undefined)
		return trace.getTracer(SDK_NAME, SDK_VERSION).startActiveSpan(
			request.method,
			{
				kind: inRequest ? SpanKind.INTERNAL : SpanKind.SERVER,
				attributes: {
					"http.request.method": request.method,
					"url.path": new URL(request.url).pathname,
				},
			},
			inRequest || !carried ? active : trace.setSpanContext(active, carried),
			async (span) => {
				try {
					const response = await fetch(request, ...args)
					span.setAttribute("http.response.status_code", response.status)
					if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
					return response
				} catch (error) {
					recordFailure(span, error)
					throw error
				} finally {
					// Streaming has only started: the span measures the time to the first byte
					span.end()
				}
			},
		)
	}
}

/** What `traceRender` reads from the handler callback's argument. */
interface RenderContext {
	readonly router: AnyRouter
	readonly responseHeaders: Headers
}

/**
 * Wrap the handler callback (`defaultStreamHandler`): names the request span after the route
 * (`ssr /projects/$id`) and joins the browser's page load to it through `Server-Timing`.
 */
export function traceRender<Context extends RenderContext, Result>(
	callback: (ctx: Context) => Result,
): (ctx: Context) => Result {
	return (ctx) => {
		// The loaders have run: the route is known
		const route = routeTemplate(ctx.router)
		if (route) trace.getActiveSpan()?.updateName(`ssr ${route}`)
		const timing = serverTiming()
		if (timing) ctx.responseHeaders.append("server-timing", timing)
		return callback(ctx)
	}
}

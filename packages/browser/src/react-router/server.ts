// `@maple-dev/browser/react-router/server`: framework mode's server render.
//
// Spans from the global tracer, under the active one, so they nest under the
// server's own OpenTelemetry setup (the Node SDK's HTTP span). The request
// span is active while `handleRequest` renders the page, which is where
// `serverTiming()` hands its trace to the browser's page load. Depends on
// `@opentelemetry/api` and `react-router` only: safe in Node and Workers.
import { SpanStatusCode, trace } from "@opentelemetry/api"
import { type HandleErrorFunction, isRouteErrorResponse, type ServerInstrumentation } from "react-router"
import { recordExceptionOnce } from "../failures"
import { traced } from "../server"
import { SDK_NAME, SDK_VERSION } from "../version"
import { routePattern, traceRouteHandlers } from "./route"

/**
 * Add to `instrumentations` in `entry.server.tsx`: a span per request, named after its route
 * (`GET /projects/:id`), with a span per loader and action under it.
 */
export const serverInstrumentation: ServerInstrumentation = {
	handler: ({ instrument }) =>
		instrument({
			// Page requests, and the `.data` requests of client-side navigations
			request: (handle, { request }) =>
				// Per request, not cached: the app may register its provider after this module loads
				trace.getTracer(SDK_NAME, SDK_VERSION).startActiveSpan(request.method, async (span) => {
					try {
						// `meta` and `statusCode` since React Router 8.1
						const { meta, statusCode } = await handle()
						if (meta) span.updateName(`${request.method} ${routePattern(meta.pattern)}`)
						span.setAttribute("http.response.status_code", statusCode)
						if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
					} finally {
						span.end()
					}
				}),
		}),
	route: traceRouteHandlers(traced),
}

/**
 * Export from `entry.server.tsx`, or call from your own: logs like React Router's default,
 * and records render errors, which reach no loader span, on the request span.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
	// An aborted request isn't a failure
	if (request.signal.aborted) return
	// A 404 for a URL no route matches carries the error it logs
	console.error(isRouteErrorResponse(error) && "error" in error && error.error ? error.error : error)
	// Thrown responses, like a 404, are expected. A loader error is already on its
	// span. The request span's status follows the response: a render error is a 500.
	const span = trace.getActiveSpan()
	if (span && !isRouteErrorResponse(error)) recordExceptionOnce(span, error)
}

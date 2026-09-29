// `@maple-dev/browser/angular/server`: joins the page load to the server render.
//
// `@angular/ssr` renders in your `server.ts`, where the page is still a
// `Response` you can add headers to. The render runs in a span under the
// request's server span, and the page tells the browser which trace to join in
// `Server-Timing`, which the `pageload` span reads. Depends on
// `@opentelemetry/api` only, no Angular import: safe in Node, edge runtimes and
// Workers. Without server OpenTelemetry it only runs `render`.
import { trace } from "@opentelemetry/api"
import { runTraced } from "../failures"
import { serverTiming } from "../server"
import { SDK_NAME, SDK_VERSION } from "../version"

/**
 * Run `render` (`angularApp.handle(req)`) in an `ssr` span and join the browser's page load to it.
 * The response, or the error, passes through unchanged apart from its `Server-Timing` header.
 */
export function tracedRender<R extends Response | null | undefined>(
	request: { readonly url?: string | undefined },
	render: () => Promise<R>,
): Promise<R> {
	const attributes = request.url === undefined ? {} : { "url.path": pathOf(request.url) }
	// Per call, not cached: the app may register its provider after this module loads
	return trace.getTracer(SDK_NAME, SDK_VERSION).startActiveSpan("ssr", { attributes }, (span) =>
		runTraced(
			span,
			async () => {
				// Before the render: after an `await`, the active span is only this one
				// if the runtime keeps async context across it, which zone.js breaks
				const timing = serverTiming()
				const response = await render()
				if (response && timing) {
					try {
						response.headers.append("server-timing", timing)
					} catch {
						// Immutable headers, like a `fetch()` response's: the page renders unjoined
					}
				}
				return response
			},
			{},
		),
	)
}

/** The path of a request URL: absolute on a fetch `Request`, path and query on a Node request. */
const pathOf = (url: string): string =>
	url.replace(/^[a-z][\d+.a-z-]*:\/\/[^/?#]*/i, "").split(/[?#]/)[0] || "/"

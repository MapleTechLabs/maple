import { Effect, Option, Schema, type Tracer } from "effect"
import { Headers, HttpTraceContext } from "effect/http"
import { API_PROXY_PREFIX } from "./api-proxy"
import type { ApiTarget } from "./worker-env"

export class ApiProxyForwardError extends Schema.TaggedError<ApiProxyForwardError>()(
	"@maple/web/ApiProxyForwardError",
	{
		message: Schema.String,
		path: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Forwards one `/_api/*` call to the API, as a server span (the browser's call
 * arriving) with a client span (the hop to the API) under it. The API's own
 * server span then parents to that client span, so the trace reads browser,
 * web Worker, API.
 *
 * Re-addressed to the API's own URL, so the API sees the Host, path and origin
 * it always has (OAuth callbacks and MCP metadata are built from them). Method,
 * headers and the streamed body carry over, `cf-connecting-ip` included.
 */
export const forwardToApi = (
	request: Request,
	url: URL,
	api: ApiTarget | undefined,
	path: string,
): Effect.Effect<Response> => {
	const incoming = HttpTraceContext.fromHeaders(Headers.fromInput(request.headers))

	return Effect.useSpan(
		`${request.method} ${API_PROXY_PREFIX}/*`,
		{
			kind: "server",
			parent: Option.getOrUndefined(incoming),
			// The path only: a query can carry a token (unsubscribe links do).
			attributes: {
				"http.request.method": request.method,
				"http.route": `${API_PROXY_PREFIX}/*`,
				"url.path": url.pathname,
			},
		},
		(server) =>
			(api === undefined
				? // A deploy without the API binding: a 503 marks the span `Error` instead of hiding it.
					Effect.succeed(new Response(null, { status: 503 }))
				: forwardOverBinding(request, url, api, path, server)
			).pipe(
				Effect.tap((response) =>
					Effect.sync(() => server.attribute("http.response.status_code", response.status)),
				),
			),
	)
}

const forwardOverBinding = (
	request: Request,
	url: URL,
	api: ApiTarget,
	path: string,
	server: Tracer.Span,
) => {
	// Assigned, not resolved: `new URL("//other.host/x", base)` would leave the API's host.
	const target = new URL(api.baseUrl)
	target.pathname = path
	target.search = url.search
	return Effect.useSpan(
		"http.client",
		{
			kind: "client",
			parent: server,
			attributes: {
				"http.request.method": request.method,
				"peer.service": "maple-api",
				"server.address": target.origin,
				"url.path": path,
			},
		},
		(client) => {
			const forwarded = new Request(target, request)
			// The API's server span parents to this hop, not straight to the browser.
			Object.entries(HttpTraceContext.toHeaders(client)).forEach(([name, value]) =>
				forwarded.headers.set(name, value),
			)
			return Effect.tryPromise({
				try: () => api.fetch(forwarded),
				catch: (cause) =>
					new ApiProxyForwardError({
						message: "The API binding rejected the request",
						path,
						cause,
					}),
			}).pipe(
				Effect.tap((response) =>
					Effect.sync(() => client.attribute("http.response.status_code", response.status)),
				),
			)
		},
	).pipe(
		// Recorded on the client span already; the browser gets a gateway error, not a hang.
		// A 5xx marks the server span `Error`; a 4xx is the API's answer and stays `Ok`.
		Effect.catchTag("@maple/web/ApiProxyForwardError", () =>
			Effect.succeed(new Response(null, { status: 502 })),
		),
	)
}

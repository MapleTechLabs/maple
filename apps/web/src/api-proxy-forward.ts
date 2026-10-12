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

/** Forwards a `/_api/*` call to the API's own URL, so its Host and OAuth callbacks are unchanged. */
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
			// No query: it can carry a token.
			attributes: {
				"http.request.method": request.method,
				"http.route": `${API_PROXY_PREFIX}/*`,
				"url.path": url.pathname,
			},
		},
		(server) =>
			(api === undefined
				? Effect.succeed(new Response(null, { status: 503 }))
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
		Effect.catchTag("@maple/web/ApiProxyForwardError", (error) =>
			Effect.logError("The API binding rejected a /_api forward").pipe(
				Effect.annotateLogs({ "error.type": error._tag, "url.path": error.path }),
				Effect.as(new Response(null, { status: 502 })),
			),
		),
	)
}

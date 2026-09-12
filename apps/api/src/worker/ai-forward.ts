// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * Forwarding the agent surfaces to maple-ai.
 *
 * The api keeps the hostname and hands `/mcp` and the chat paths to the AI
 * Worker over a service binding, which is what keeps `/mcp`'s OAuth issuer and
 * its RFC 8707 resource identifiers on this origin — moving them would
 * invalidate every registered MCP client.
 *
 * Its own module for two reasons: the path predicate is the contract between
 * the two Workers and is worth testing without building a route graph, and the
 * binding arrives as an unparsed `env` value that has to be narrowed rather
 * than asserted.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { API_CORS_RESPONSE_HEADERS } from "../http/api-cors"

/**
 * The paths maple-ai serves.
 *
 * `/mcp` is matched exactly rather than by prefix so a future `/mcp-something`
 * on this origin is not silently swallowed. Kept in step with
 * `MapleAiApi` and the AI Worker's raw routers: anything this misses 404s from
 * api's own router, and anything it over-matches never reaches api's routes at
 * all.
 */
export const forwardsToAi = (path: string): boolean =>
	path === "/mcp" ||
	path.startsWith("/mcp/") ||
	path.startsWith("/api/chat/") ||
	path.startsWith("/internal/chat/")

/**
 * A service binding off `env`, narrowed rather than cast.
 *
 * Only `fetch` is checked, because that is all the forward calls; a binding
 * that is present but not a fetcher is then a logged 503 instead of a defect
 * inside alchemy's adapter.
 */
export const isCloudflareFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function"

/** maple-ai could not be reached. CORS headers included: the dashboard's chat calls this from a browser. */
export const aiUnavailableResponse = (): HttpServerResponse.HttpServerResponse =>
	HttpServerResponse.text("maple-ai is unavailable", {
		status: 503,
		headers: API_CORS_RESPONSE_HEADERS,
	})

/** The W3C header carrying this hop's span, sampled flag included, as `apps/web`'s fetch wrapper writes it. */
const traceparentOf = (span: { readonly traceId: string; readonly spanId: string }): string =>
	`00-${span.traceId}-${span.spanId}-01`

/**
 * Forward one request to maple-ai and answer with its response.
 *
 * Byte-transparent but for one header: the same method, the original `Host`
 * (which is what keeps `/mcp`'s OAuth `resource_metadata` pointing at this
 * origin's well-known), every other header, and both bodies as streams. The
 * chat tail is an open `text/event-stream`, so buffering either side would turn
 * a live transcript into a hang.
 *
 * The exception is `traceparent`, which is replaced with THIS hop's server
 * span. Without it maple-ai starts a new root trace and one `/mcp` call reads
 * as two unrelated traces with no edge between the Workers on the service map.
 * Replacing rather than preserving is what parents ai's span to api's: a client
 * that sent its own `traceparent` is already this span's parent, so the trace
 * stays whole either way.
 *
 * The one expected failure is a request that cannot be rendered to the web
 * shape, which on workerd means never — the bridge's request already IS one, so
 * `toWeb` hands it back untouched. It is answered as the same 503 an absent
 * binding gets rather than widened into this handler's error channel, where it
 * would not match the bridge's `HttpEffect`. A binding call that rejects stays a
 * defect the bridge renders and reports, exactly as before the split.
 */
export const forwardToAi = (
	fetcher: Fetcher,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
	Effect.gen(function* () {
		const web = yield* HttpServerRequest.toWeb(request)
		const span = yield* Effect.option(Effect.currentSpan)
		const forwarded = Option.match(span, {
			onNone: () => web,
			onSome: (current) => {
				const headers = new Headers(web.headers)
				headers.set("traceparent", traceparentOf(current))
				return new Request(web, { headers })
			},
		})
		return yield* Cloudflare.fromCloudflareFetcher(fetcher).fetch(HttpServerRequest.fromWeb(forwarded))
	}).pipe(
		Effect.catch((error) =>
			Effect.logError("Forwarding to the AI worker failed", error).pipe(
				Effect.annotateLogs({ method: request.method, path: request.url }),
				Effect.as(aiUnavailableResponse()),
			),
		),
	)

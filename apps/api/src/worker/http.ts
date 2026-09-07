/**
 * The api Worker's request path: the route graph built once per isolate on
 * the first request, and the `fetch` handler the bridge serves around it.
 */
import {
	WorkerConfigProviderLayer,
	WorkerEnvironment,
	workerEnvironmentLayer,
} from "@maple/infra/worker-runtime"
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Clock, type Context, Effect, Exit, FileSystem, Layer, Path, Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { API_CORS_RESPONSE_HEADERS, apiCorsPreflightResponse } from "../http/api-cors"
import { v2WorkerUnavailableResponse } from "../http/v2-worker-unavailable"
import { persistSession, preloadSession } from "../mcp/lib/session-store"
import type { KeyValueStore } from "../platform/bindings"
import type { ApiPortsLayer } from "./bindings"
import { pgScopeModule } from "./modules"

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
	HttpPlatform.HttpPlatform,
	HttpPlatform.make({
		platform: "web",
		compression: HttpPlatform.makeCompressionWeb({
			algorithms: ["gzip", "deflate"],
			transform: (algorithm) => HttpPlatform.compressionTransformWeb(algorithm),
		}),
		fileResponse: (_path, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
		fileWebResponse: (_file, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
	}),
).pipe(Layer.provideMerge(WorkerFileSystemLive), Layer.provideMerge(Etag.layer))

export const WorkerPlatformLive = Layer.mergeAll(
	Path.layer,
	Etag.layer,
	WorkerFileSystemLive,
	WorkerHttpPlatformLive,
)

/**
 * A layer built into a handler for the isolate, under the isolate's own
 * context rather than the fiber that happens to run the build.
 *
 * The build runs lazily on the first event, inside that event's fiber. The
 * HttpApi group layers capture the fiber context they are built in and wrap
 * every route handler in it, and that captured context *overrides* the
 * per-request one — so a graph built inside request A served every later
 * request with A's `HttpServerRequest` (its bearer, its content-type, its
 * body), A's execution context and A's already-flushed span exporter. In prod
 * that was a browser 401'd with the Clerk verdict on a curl's garbage bearer,
 * 403'd as an MCP client's API key, and 415'd as a GET without a JSON body.
 * `isolate` is the context the init captured before any event existed: what
 * the bridge hands every event, with nothing that belongs to one of them.
 *
 * `routes` may still carry the router and the per-request markers the router
 * discharges; a layer that needs anything else from the ambient context does
 * not compile, as before, because nothing else is there to be found.
 */
export const buildIsolateHandler = <E>(
	isolate: Context.Context<never>,
	routes: Layer.Layer<
		never,
		E,
		HttpRouter.HttpRouter | HttpRouter.Request<"Error" | "GlobalError" | "Requires", unknown>
	>,
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make()
		return yield* HttpRouter.toHttpEffect(routes).pipe(
			Scope.provide(scope),
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
			Effect.map(bridgeHandler),
		)
	}).pipe(Effect.updateContext((_: Context.Context<never>) => isolate))

/** The route graph as one request handler, built once per isolate on the first request, over the Worker's ports. */
export const buildApp = (isolate: Context.Context<never>, ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const [{ HttpServicesLive }, { AllRoutes, ApiAuthLive }, { layerPg }] = yield* Effect.all([
			Effect.promise(() => import("../runtime/service-graph")),
			Effect.promise(() => import("../runtime/http-graph")),
			Effect.promise(() => import("../platform/DatabasePgLive")),
		])
		return yield* buildIsolateHandler(
			isolate,
			AllRoutes.pipe(
				Layer.provideMerge(HttpServicesLive),
				Layer.provideMerge(ApiAuthLive),
				Layer.provideMerge(WorkerPlatformLive),
				Layer.provideMerge(layerPg),
				Layer.provideMerge(workerEnvironmentLayer),
				Layer.provideMerge(WorkerConfigProviderLayer),
				Layer.provide(ports),
			),
		)
	})

/**
 * The router's handler as the bridge serves it.
 *
 * SAFETY: `toHttpEffect` keeps the routes' request-scoped markers in the
 * handler's type — the services they read per request, and the failures they
 * declare — but the context it builds runs them with every service the graph
 * merged (the same services `Layer.provideMerge` put there), and a failure
 * that escapes a route reaches alchemy's boundary, which renders a Respondable
 * as its own response and anything else as an empty 500. The retired entry
 * discharged the same markers by handing `toWebHandler` an empty request
 * context; this is that discharge, in one place.
 */
const bridgeHandler = <E, R>(
	handler: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | Scope.Scope | HttpServerRequest.HttpServerRequest
	>,
): HttpEffect => handler as HttpEffect

const pathOf = (url: string): string => {
	const query = url.indexOf("?")
	return query === -1 ? url : url.slice(0, query)
}

const isV2Path = (path: string): boolean => path === "/v2" || path.startsWith("/v2/")

/** The route graph could not finish bootstrapping: the canonical v2 fallback, or a plain 504 for the rest. */
const unavailableResponse = (path: string) =>
	HttpServerResponse.fromWeb(
		isV2Path(path)
			? v2WorkerUnavailableResponse()
			: new Response("The API worker is temporarily unavailable.", { status: 504 }),
	)

/**
 * The request handler the bridge serves. Liveness and preflights answer before
 * the route graph exists: neither needs the domain graph, authentication, the
 * database scope or the route codecs, and a cold isolate can report health
 * when an unrelated binding is unavailable. Everything else runs the router
 * under one Postgres connection for the request.
 *
 * MCP session persistence is driven from here rather than from inside the
 * MCP layer: the sessions Map hands Effect's MCP server its transcript, and
 * the KV copy behind it is what lets the next isolate find a session this one
 * issued.
 */
export const makeFetch = (app: Effect.Effect<HttpEffect, unknown>, sessions: KeyValueStore) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const path = pathOf(request.url)
		if (request.method === "GET" && path === "/health") {
			// The revision this isolate is running, so the deploy that just
			// uploaded a script can assert the script is the one now serving.
			// Alchemy isolates per-resource failures, so a red deploy still
			// leaves every sibling Worker updated and this one on the old
			// bundle — the body stays `OK` and the answer stays graph-free.
			const revision = (yield* Cloudflare.WorkerEnvironment).COMMIT_SHA
			return HttpServerResponse.text("OK", {
				headers: revision
					? { ...API_CORS_RESPONSE_HEADERS, "x-maple-revision": revision }
					: API_CORS_RESPONSE_HEADERS,
			})
		}
		if (request.method === "OPTIONS") return HttpServerResponse.fromWeb(apiCorsPreflightResponse())

		const env = yield* Cloudflare.WorkerEnvironment
		const isMcp = request.method === "POST" && path === "/mcp"
		const requestSessionId = isMcp ? request.headers["mcp-session-id"] : undefined
		const startedAt = yield* Clock.currentTimeMillis

		// The cold handler build and the independent KV read overlap: warm
		// requests resolve both at once, cold MCP requests hide KV latency behind
		// module evaluation.
		const [built, { withPgConnectionScope }] = yield* Effect.all(
			[
				Effect.exit(app),
				pgScopeModule,
				requestSessionId ? preloadSession(sessions, requestSessionId) : Effect.void,
			],
			{ concurrency: "unbounded" },
		)
		if (Exit.isFailure(built)) {
			yield* Effect.logError("API worker route graph failed to build", built.cause).pipe(
				Effect.annotateLogs({ method: request.method, path }),
			)
			return unavailableResponse(path)
		}

		const response = yield* withPgConnectionScope(built.value).pipe(
			Effect.provideService(WorkerEnvironment, env),
		)

		if (isMcp) {
			// Only persist when the server issued a new session — i.e. on
			// `initialize`, where the response sid differs from the request sid
			// (or the request had none). Subsequent requests echo the same sid;
			// re-putting on every call would burn KV write quota for no reason.
			const responseSessionId = response.headers["mcp-session-id"]
			if (responseSessionId && responseSessionId !== requestSessionId) {
				const put = persistSession(sessions, responseSessionId)
				if (put) {
					const exec = yield* Cloudflare.WorkerExecutionContext
					yield* exec.waitUntil(put)
				}
			}
		}
		if (isMcp) {
			const now = yield* Clock.currentTimeMillis
			yield* Effect.logInfo("MCP request handled").pipe(
				Effect.annotateLogs({
					"mcp.session_id": requestSessionId ?? "-",
					"mcp.response_session_id": response.headers["mcp-session-id"] ?? "-",
					"http.response.status_code": response.status,
					duration_ms: now - startedAt,
				}),
			)
		}
		return response
	})

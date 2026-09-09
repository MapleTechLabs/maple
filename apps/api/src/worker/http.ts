/**
 * The api Worker's request path: the route graph built once per isolate on
 * the first request, and the `fetch` handler the bridge serves around it.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Cause, Clock, type Context, Effect, Exit, FileSystem, Layer, Path, Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { API_CORS_RESPONSE_HEADERS, apiCorsPreflightResponse } from "../http/api-cors"
import { v2WorkerUnavailableResponse } from "../http/v2-worker-unavailable"
import type { MapleDbConnection } from "../platform/bindings"
import { layerPg } from "../platform/DatabasePgLive"
import { recordRenderedFailure } from "../routes/rendered-failure"
import { withPgConnectionScope } from "../platform/pg-connection-scope"
import type { ApiPortsLayer } from "./bindings"

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

export const WorkerPlatformLive = Layer.mergeAll(Path.layer, WorkerHttpPlatformLive)

/**
 * A build run under the isolate's context — never the first event's fiber —
 * on a scope closed only if the build fails (workerd has no teardown).
 *
 * The builds run lazily on the first event, inside that event's fiber, and
 * the HttpApi group layers capture the fiber context they are built in and
 * wrap every route handler in it, overriding the per-request one: a graph
 * built inside request A served every later request with A's
 * `HttpServerRequest` (its bearer, its content-type, its body), A's execution
 * context and A's already-flushed span exporter. `isolate` is the context the
 * init captured before any event existed.
 */
export const forIsolate =
	(isolate: Context.Context<never>) =>
	<A, E>(build: Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, E> =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			return yield* build.pipe(
				Scope.provide(scope),
				Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
			)
		}).pipe(Effect.updateContext((_: Context.Context<never>) => isolate))

/** The route graph as the bridge's handler, built for the isolate. */
export const buildIsolateHandler = <E>(
	isolate: Context.Context<never>,
	routes: Layer.Layer<
		never,
		E,
		HttpRouter.HttpRouter | HttpRouter.Request<"Error" | "GlobalError" | "Requires", unknown>
	>,
) => forIsolate(isolate)(HttpRouter.toHttpEffect(routes)).pipe(Effect.map(bridgeHandler))

/** The route graph as one request handler, built once per isolate on the first request, over the Worker's ports. */
export const buildApp = (isolate: Context.Context<never>, ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const [{ HttpServicesLive }, { AllRoutes, ApiAuthLive }] = yield* Effect.all([
			Effect.promise(() => import("../runtime/service-graph")),
			Effect.promise(() => import("../runtime/http-graph")),
		])
		return yield* buildIsolateHandler(
			isolate,
			AllRoutes.pipe(
				Layer.provideMerge(HttpServicesLive),
				Layer.provideMerge(ApiAuthLive),
				Layer.provideMerge(WorkerPlatformLive),
				Layer.provideMerge(layerPg),
				Layer.provide(ports),
			),
		)
	})

/**
 * SAFETY: `toHttpEffect` keeps the routes' error and requirement markers in
 * the handler's type; the bridge's `safeHttpEffect` renders any escaping cause
 * (a Respondable as its own response, anything else as a 500), so the markers
 * are discharged here, once.
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
 * The last point the cause still exists: the bridge's `safeHttpEffect` renders it and logs nothing
 * when every reason is `ErrorReporter.isIgnored`. Interrupts are client aborts and stay silent.
 */
const recordEscapedCause = (method: string, path: string, cause: Cause.Cause<unknown>) => {
	if (Cause.hasInterruptsOnly(cause)) return Effect.void
	const first = Cause.prettyErrors(cause)[0]
	return recordRenderedFailure({
		group: "route-graph",
		operation: `${method} ${path}`,
		errorType: first?.name ?? "Unknown",
		summary: "Cause escaped the route graph",
		message: first?.message ?? "",
		status: 500,
		stack: first?.stack,
		cause,
	})
}

/**
 * How cold the isolate was when this 5xx arrived. Which layer rendered it is already on the span: a seam
 * that named the failure left an `exception` event, and the tracer labels the rest generically.
 */
const recordIsolateAge = (isolate: { readonly ageMs: number; readonly ordinal: number }) =>
	Effect.annotateCurrentSpan({
		"maple.isolate.age_ms": isolate.ageMs,
		"maple.isolate.request_ordinal": isolate.ordinal,
	})

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
 * issued. The ports are provided around the whole request, the same way the
 * background events get them.
 */
export const makeFetch = (app: Effect.Effect<HttpEffect, unknown>, ports: Layer.Layer<MapleDbConnection>) => {
	// Isolate-scoped: the Worker's init calls `makeFetch` once. The unattributed 500s all landed
	// within ~60ms of an isolate's first request, so the span has to carry that shape.
	let firstRequestAt: number | undefined
	let served = 0
	return Effect.gen(function* () {
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

		const isMcp = request.method === "POST" && path === "/mcp"
		const startedAt = yield* Clock.currentTimeMillis
		firstRequestAt ??= startedAt
		const ordinal = ++served

		const built = yield* Effect.exit(app)
		if (Exit.isFailure(built)) {
			yield* Effect.logError("API worker route graph failed to build", built.cause).pipe(
				Effect.annotateLogs({ method: request.method, path }),
			)
			return unavailableResponse(path)
		}

		const response = yield* withPgConnectionScope(built.value).pipe(
			Effect.tapCause((cause) => recordEscapedCause(request.method, path, cause)),
		)

		if (response.status >= 500) {
			yield* recordIsolateAge({ ageMs: startedAt - firstRequestAt, ordinal })
		}

		if (isMcp) {
			// The transport is stateless, so there is no session to carry across
			// requests and nothing to write back — see `mcp/transport/stateless-http.ts`.
			const now = yield* Clock.currentTimeMillis
			yield* Effect.logInfo("MCP request handled").pipe(
				Effect.annotateLogs({
					"http.response.status_code": response.status,
					duration_ms: now - startedAt,
				}),
			)
		}
		return response
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the request IS the boundary the ports belong to.
		Effect.provide(ports),
	)
}

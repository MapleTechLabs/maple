/**
 * The AI Worker's request path: the route graph built once per isolate on the
 * first request, and the `fetch` handler the bridge serves around it.
 *
 * Copied from apps/api rather than imported. The two diverge in what they carry
 * around a request — api's has the v2 fallback, the isolate-age instrumentation
 * and the CORS preflight it answers for the whole origin — and a shared version
 * would have to grow a flag for each. What must not diverge is the isolate
 * context handling below, so that comment is carried over verbatim.
 */
import type { HttpEffect } from "alchemy/Http"
import * as Cloudflare from "alchemy/Cloudflare"
import { type Context, Effect, Exit, FileSystem, Layer, Path, Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { withPgConnectionScope } from "@/platform/pg-connection-scope"
import { layerPg } from "@/platform/DatabasePgLive"
import type { AiPortsLayer } from "@ai/worker/bindings"

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
 * A build run under the isolate's context — never the first event's fiber — on a
 * scope closed only if the build fails (workerd has no teardown).
 *
 * The builds run lazily on the first event, inside that event's fiber, and the
 * HttpApi group layers capture the fiber context they are built in and wrap
 * every route handler in it, overriding the per-request one: a graph built
 * inside request A served every later request with A's `HttpServerRequest` (its
 * bearer, its content-type, its body), A's execution context and A's
 * already-flushed span exporter. `isolate` is the context the init captured
 * before any event existed.
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

/**
 * SAFETY: `toHttpEffect` keeps the routes' error and requirement markers in the
 * handler's type; the bridge's `safeHttpEffect` renders any escaping cause, so
 * the markers are discharged here, once.
 */
const bridgeHandler = <E, R>(
	handler: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | Scope.Scope | HttpServerRequest.HttpServerRequest
	>,
): HttpEffect => handler as HttpEffect

/**
 * The route graph as the bridge's handler, built for the isolate.
 *
 * The load-bearing parameter is the third: the graph may require nothing from
 * the request context beyond the router and its own markers, so a service a
 * handler reads per request fails the build naming itself instead of failing
 * every request with "Service not found".
 */
export const buildIsolateHandler = <ROut, E>(
	isolate: Context.Context<never>,
	routes: Layer.Layer<
		ROut,
		E,
		HttpRouter.HttpRouter | HttpRouter.Request<"Error" | "GlobalError" | "Requires", unknown>
	>,
) => forIsolate(isolate)(HttpRouter.toHttpEffect(routes)).pipe(Effect.map(bridgeHandler))

/** The route graph as one request handler, built once per isolate on the first request. */
export const buildApp = (isolate: Context.Context<never>, ports: AiPortsLayer) =>
	Effect.gen(function* () {
		const [{ McpServicesLive }, { AllRoutes, AiAuthLive }] = yield* Effect.all([
			Effect.promise(() => import("@ai/runtime/mcp-service-graph")),
			Effect.promise(() => import("@ai/runtime/http-graph")),
		])
		return yield* buildIsolateHandler(
			isolate,
			AllRoutes.pipe(
				Layer.provideMerge(McpServicesLive),
				Layer.provideMerge(AiAuthLive),
				Layer.provideMerge(WorkerPlatformLive),
				Layer.provideMerge(layerPg),
				Layer.provide(ports),
			),
		)
	})

/**
 * The request handler the bridge serves. Liveness answers before the route graph
 * exists: it needs neither the domain graph nor the database, and a cold isolate
 * can report health when an unrelated binding is unavailable.
 *
 * No CORS preflight branch here, unlike api's: the api owns the origin and
 * answers `OPTIONS` before it forwards, so a second set of headers from this
 * Worker would be a duplicate `access-control-allow-origin`, which browsers
 * reject outright.
 */
export const makeFetch = <E>(app: Effect.Effect<HttpEffect, E>, ports: AiPortsLayer) => {
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const path = pathOf(request.url)
		if (request.method === "GET" && path === "/health") {
			const revision = (yield* Cloudflare.WorkerEnvironment).COMMIT_SHA
			return HttpServerResponse.text("OK", {
				headers: typeof revision === "string" ? { "x-maple-revision": revision } : undefined,
			})
		}

		const built = yield* Effect.exit(app)
		if (Exit.isFailure(built)) {
			yield* Effect.logError("AI worker route graph failed to build", built.cause).pipe(
				Effect.annotateLogs({ method: request.method, path }),
			)
			return HttpServerResponse.text("maple-ai is unavailable", { status: 503 })
		}
		return yield* withPgConnectionScope(built.value)
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the request IS the boundary the ports belong to.
		Effect.provide(ports),
	)
}

const pathOf = (url: string): string => {
	const query = url.indexOf("?")
	return query === -1 ? url : url.slice(0, query)
}

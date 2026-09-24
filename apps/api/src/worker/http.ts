import { WorkerPlatformLive, forIsolate, bridgeHandler } from "@maple/infra/worker-http"
/**
 * The api Worker's request path: the route graph built once per isolate on
 * the first request, and the `fetch` handler the bridge serves around it.
 */
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Cause, Clock, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { API_CORS_RESPONSE_HEADERS, apiCorsPreflightResponse } from "@maple/backend/http/api-cors"
import { aiUnavailableResponse, forwardsToAi, forwardToAi, isCloudflareFetcher } from "./ai-forward"
import { v2WorkerUnavailableResponse } from "../http/v2-worker-unavailable"
import type { MapleDbConnection } from "@maple/backend/platform/bindings"
import { layerPg } from "@maple/backend/platform/DatabasePgLive"
import { recordRenderedFailure } from "@maple/backend/http/rendered-failure"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import type { ApiPortsLayer } from "./bindings"

/**
 * The route graph as the bridge's handler, built for the isolate.
 *
 * The load-bearing parameter is the third: the graph may require nothing from
 * the request context beyond the router and its own markers, so a service a
 * handler reads per request fails the build naming itself instead of failing
 * every request with "Service not found".
 *
 * The output parameter is deliberately open. The composed graph surfaces the
 * service layers it was provided, and pinning it to `never` only ever appeared
 * to hold: until the MCP routes moved out, `McpLive` widened the whole
 * composition to `any` and the constraint was satisfied vacuously.
 */
export const buildIsolateHandler = <ROut, E>(
	isolate: Context.Context<never>,
	routes: Layer.Layer<
		ROut,
		E,
		HttpRouter.HttpRouter | HttpRouter.Request<"Error" | "GlobalError" | "Requires", unknown>
	>,
	memoMap?: Layer.MemoMap,
) =>
	forIsolate(isolate)(
		memoMap === undefined
			? HttpRouter.toHttpEffect(routes)
			: Effect.gen(function* () {
					const scope = yield* Scope.Scope
					// Request markers describe handler requirements, not services consumed while building.
					// HttpRouter.toHttpEffect erases the same phantom markers internally.
					// A fresh router is essential: only services may be shared across these graphs.
					const context = yield* Layer.buildWithMemoMap(
						(routes as Layer.Layer<ROut, E, HttpRouter.HttpRouter>).pipe(
							Layer.provideMerge(Layer.fresh(HttpRouter.layer)),
						),
						memoMap,
						scope,
					)
					// oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Return the handler for later requests, never execute it during the build.
					return Context.get(context, HttpRouter.HttpRouter).asHttpEffect()
				}),
	).pipe(Effect.map(bridgeHandler))

/** The route graph as one request handler, built once per isolate on the first request, over the Worker's ports. */
export const buildApp = (
	isolate: Context.Context<never>,
	ports: ApiPortsLayer,
	graph: "full" | "query" = "full",
	memoMap?: Layer.MemoMap,
) =>
	Effect.gen(function* () {
		if (graph === "query") {
			const { QueryRoutes } = yield* Effect.promise(() => import("../runtime/query-http-graph"))
			return yield* buildIsolateHandler(
				isolate,
				QueryRoutes.pipe(
					Layer.provideMerge(WorkerPlatformLive),
					Layer.provideMerge(layerPg),
					Layer.provide(ports),
				),
				memoMap,
			)
		}
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
			memoMap,
		)
	})

/**
 * Share service instances, but never build two graphs concurrently. Layer's
 * internal waiters are fibers; a native Promise hands a waiting graph back to
 * its own Workers request I/O context, just like cachedRecoverable does.
 */
export const makeAppGraphs = (isolate: Context.Context<never>, ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const memo = yield* Layer.makeMemoMap
		let tail = Promise.resolve()
		const build = (graph: "full" | "query") =>
			Effect.uninterruptibleMask((restore) =>
				Effect.suspend(() => {
					const previous = tail
					let release!: () => void
					tail = new Promise<void>((resolve) => {
						release = resolve
					})
					// Wait uninterruptibly for ownership; a cancelled waiter must not unlock
					// the next build while its predecessor is still using the shared memo.
					return Effect.promise(() => previous).pipe(
						Effect.andThen(restore(buildApp(isolate, ports, graph, memo))),
						Effect.ensuring(Effect.sync(() => release())),
					)
				}),
			)
		return {
			app: yield* cachedRecoverable(build("full")),
			queryApp: yield* cachedRecoverable(build("query")),
		}
	})

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
 * Ordinary request ordinals include successful requests and graph-build failures,
 * so production can compare cold and warm traffic without conditioning on errors.
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
 */
export const makeFetch = (
	app: Effect.Effect<HttpEffect, unknown>,
	ports: Layer.Layer<MapleDbConnection>,
	queryApp: Effect.Effect<HttpEffect, unknown> = app,
) => {
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

		// The agent surfaces moved to maple-ai; this origin keeps serving them.
		// Ahead of the route graph on purpose — that is the whole point of the
		// split, so a `/mcp` call no longer builds `AllRoutes` and `ApiAuthLive`.
		// What the forward preserves, and the one header it replaces, is spelled
		// out in `ai-forward.ts`.
		if (forwardsToAi(path)) {
			const aiWorker = (yield* Cloudflare.WorkerEnvironment).AI_WORKER
			if (!isCloudflareFetcher(aiWorker)) {
				yield* Effect.logError("AI worker binding is missing").pipe(
					Effect.annotateLogs({ method: request.method, path }),
				)
				return aiUnavailableResponse()
			}
			return yield* forwardToAi(aiWorker, request)
		}

		const startedAt = yield* Clock.currentTimeMillis
		firstRequestAt ??= startedAt
		const ordinal = ++served

		yield* recordIsolateAge({ ageMs: startedAt - firstRequestAt, ordinal })

		const selectedApp =
			path === "/internal/query-engine" || path.startsWith("/internal/query-engine/") ? queryApp : app
		const built = yield* Effect.exit(selectedApp)
		if (Exit.isFailure(built)) {
			yield* Effect.logError("API worker route graph failed to build", built.cause).pipe(
				Effect.annotateLogs({ method: request.method, path }),
			)
			return unavailableResponse(path)
		}

		const response = yield* withPgConnectionScope(built.value).pipe(
			Effect.tapCause((cause) => recordEscapedCause(request.method, path, cause)),
		)

		return response
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the request IS the boundary the ports belong to.
		Effect.provide(ports),
	)
}

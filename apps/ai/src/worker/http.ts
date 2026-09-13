import { WorkerPlatformLive, forIsolate, bridgeHandler } from "@maple/infra/worker-http"
/**
 * The AI Worker's request path: the route graph built once per isolate on the
 * first request, and the `fetch` handler the bridge serves around it.
 *
 * Request handling belongs to this Worker; platform and isolate context ownership
 * are shared with the API through @maple/infra/worker-http.
 */
import type { HttpEffect } from "alchemy/Http"
import * as Cloudflare from "alchemy/Cloudflare"
import { type Context, Effect, Exit, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { layerPg } from "@maple/backend/platform/DatabasePgLive"
import type { AiPortsLayer } from "./bindings"

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
			Effect.promise(() => import("../runtime/mcp-service-graph")),
			Effect.promise(() => import("../runtime/http-graph")),
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

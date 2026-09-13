import type { HttpEffect } from "alchemy/Http"
import { Context, Effect, Exit, FileSystem, Layer, Path, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"

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

/**
 * SAFETY: `toHttpEffect` keeps the routes' error and requirement markers in
 * the handler's type; the bridge's `safeHttpEffect` renders any escaping cause
 * (a Respondable as its own response, anything else as a 500), so the markers
 * are discharged here, once.
 */
export const bridgeHandler = <E, R>(
	handler: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | Scope.Scope | HttpServerRequest.HttpServerRequest
	>,
): HttpEffect => handler as HttpEffect

import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Context, Effect, Exit, FileSystem, Layer, Logger, Path, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Etag from "effect/http/Etag"
import * as HttpPlatform from "effect/http/HttpPlatform"

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
 * The init's context minus execution context, memo map and loggers: `HttpApiBuilder.group`
 * captures its build context and it wins over the event's, so handlers would log to the console.
 */
export const isolateContext = (context: Context.Context<never>): Context.Context<never> =>
	Context.omit(Cloudflare.WorkerExecutionContext, Layer.CurrentMemoMap, Logger.CurrentLoggers)(context)

/**
 * Runs a build under the isolate's context, never the first event's fiber (a graph built inside
 * request A would serve every later request with A's request and context). Scope closes only on failure.
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

/** SAFETY: the bridge's `safeHttpEffect` renders any escaping cause, so the markers are discharged here. */
export const bridgeHandler = <E, R>(
	handler: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | Scope.Scope | HttpServerRequest.HttpServerRequest
	>,
): HttpEffect => handler as HttpEffect

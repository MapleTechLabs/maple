import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

/**
 * The services `keys` name, taken from the context this layer is built in.
 *
 * Only the named keys cross: the build context also carries the isolate's scope, its memo map and
 * the references of the fiber that built the graph, none of which may shadow the request's own.
 */
const fromBuild = <const Keys extends ReadonlyArray<Context.Key<any, any>>>(
	...keys: Keys
): Layer.Layer<Context.Service.Identifier<Keys[number]>, never, Context.Service.Identifier<Keys[number]>> =>
	Layer.effectContext(
		Effect.map(Effect.context<Context.Service.Identifier<Keys[number]>>(), Context.pick(...keys)),
	)

/**
 * Hand a router's handlers, from the layer the router is built in, the services they read per
 * request.
 *
 * A route handler runs in the request's own context, not in the layer its router was built from.
 * An `HttpApiBuilder` group captures its build context for its handlers; a raw `HttpRouter` does
 * not, so a service read inside one of its handlers compiles and fails on every request with
 * "Service not found" — every chat route, 2026-09-08. Either way the read is left on the layer as
 * a `Request<"Requires", X>` marker, which `buildIsolateHandler` refuses unless `X` is one of the
 * Worker's ports. This discharges it the way Effect intends: `HttpRouter.provideRequest` builds
 * `X` once, where the router is built, and provides it to each request. A service nobody provides
 * there is a build-time type error at the graph.
 */
export const provideRequestFromBuild = <const Keys extends ReadonlyArray<Context.Key<any, any>>>(
	...keys: Keys
) => HttpRouter.provideRequest(fromBuild(...keys))

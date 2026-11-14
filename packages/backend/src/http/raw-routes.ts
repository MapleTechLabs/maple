import type { Layer } from "effect"
import type { HttpRouter } from "effect/http"

/**
 * Services a raw router's handlers still expect from the request context, beyond `Provided` (the
 * Worker's ports, which every request carries). Each is a runtime "Service not found".
 */
type LeakedRequestServices<Routes extends Layer.Any, Provided> =
	Layer.Services<Routes> extends infer Marker
		? Marker extends HttpRouter.Request<"Requires", infer Service>
			? Exclude<Service, Provided>
			: never
		: never

/**
 * A raw `HttpRouter` handler runs in the request's own context. Unlike an `HttpApiBuilder`
 * group, nothing carries the router's build context into it, so a service it reads per request
 * has to arrive through `HttpRouter.provideRequest` (see `ChatSessionsRouter`). Read inside the
 * handler instead, it compiles, because the isolate builder erases the marker, and fails every
 * request with "Service not found", which is what took the chat routes down on 2026-09-08. This
 * turns that into a build failure naming the leaked service.
 *
 * `Provided` is what every request of the Worker carries: `Layer.Success` of its ports layer.
 */
export const rawRoutes =
	<Provided>() =>
	<Routes extends Layer.Any>(
		routes: Routes &
			([LeakedRequestServices<Routes, Provided>] extends [never]
				? unknown
				: { readonly leakedRequestServices: LeakedRequestServices<Routes, Provided> }),
	) =>
		routes

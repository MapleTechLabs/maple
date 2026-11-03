import type { Layer } from "effect"
import type { HttpRouter } from "effect/http"
import type { AiPortsLayer } from "../worker/bindings"

/**
 * Services a raw router's handlers still expect from the request context, beyond the Worker's
 * ports, which every request carries. Each is a runtime "Service not found".
 */
type LeakedRequestServices<Routes extends Layer.Any> =
	Layer.Services<Routes> extends infer Marker
		? Marker extends HttpRouter.Request<"Requires", infer Service>
			? Exclude<Service, Layer.Success<AiPortsLayer>>
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
 * Carried over from apps/api verbatim. It is worth more here, not less: this Worker is almost
 * entirely raw routers.
 */
export const rawRoutes = <Routes extends Layer.Any>(
	routes: Routes &
		([LeakedRequestServices<Routes>] extends [never]
			? unknown
			: { readonly leakedRequestServices: LeakedRequestServices<Routes> }),
) => routes

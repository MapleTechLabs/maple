// Shared by the browser and server entries: depends on `react-router` types only.
import type { InstrumentationHandlerResult, InstrumentRouteFunction } from "react-router"

/** `traced` from the browser entry or the server one. */
type Traced = (name: string, fn: () => Promise<void>) => Promise<void>

/** A route pattern with the leading slash framework mode's patterns leave off: `projects/:id` is `/projects/:id`. */
export const routePattern = (pattern: string): string => `/${pattern}`.replace(/\/+/g, "/")

/**
 * The pattern of the matched routes, from their paths: each is relative to its
 * parent, and layout and index routes have none. Joined the way React Router
 * joins the `pattern` it reports, so both name a route the same.
 */
export const matchedPattern = (paths: readonly (string | undefined)[]): string =>
	routePattern(paths.filter(Boolean).join("/"))

/** A span per loader and action run, named after the route id: `loader routes/project`. */
export const traceRouteHandlers =
	(traced: Traced): InstrumentRouteFunction =>
	(route) => {
		const handlerSpan = async (name: string, handler: () => Promise<InstrumentationHandlerResult>) => {
			try {
				await traced(name, async () => {
					// React Router resolves the handler to a result and hands the loader's
					// own error to the app itself. Only thrown `Error`s are `"error"`:
					// `redirect()`, `data()` and thrown Responses aren't failures.
					const result = await handler()
					if (result.status === "error") throw result.error
				})
			} catch {
				// Rethrown into `traced` only to record it on the span
			}
		}
		route.instrument({
			loader: (handler) => handlerSpan(`loader ${route.id}`, handler),
			action: (handler) => handlerSpan(`action ${route.id}`, handler),
		})
	}

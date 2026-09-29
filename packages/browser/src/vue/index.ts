// `@maple-dev/browser/vue`: Vue Router navigations and the errors Vue catches.
//
// Vue Router reports where a navigation starts (`beforeEach`) and where it's
// confirmed (`afterEach`), and Vue renders the new route on the next tick. A
// navigation span covers both, so the requests a page starts in `setup` nest
// under it. Works with Vue Router 4 and 5, and in Nuxt's client plugins.
import { type App, nextTick, type Plugin } from "vue"
import type { RouteLocationNormalized, Router } from "vue-router"
import { captureException } from "../errors"
import { endNavigation, interruptNavigation, startNavigation } from "../navigation"

/**
 * `NavigationFailureType.cancelled`, the same in Vue Router 4 and 5. Not imported: `MapleVue` works
 * without Vue Router.
 */
const CANCELLED = 8

/** Routers already traced: a second `traceRouter` would start every span twice. */
const tracedRouters = new WeakSet<Router>()

/** The location that started a navigation. A redirect runs the guards again for its target, with this as `redirectedFrom`. */
const originOf = (to: RouteLocationNormalized): object => to.redirectedFrom ?? to

/** The deepest matched route's full path, parents included: `/projects/:id`. */
const templateOf = (to: RouteLocationNormalized): string | undefined => to.matched.at(-1)?.path

/**
 * Call right after `createRouter`, before adding other guards: starts a span for each navigation,
 * named after its route (`/projects/:id`), and reports errors thrown in guards.
 */
export function traceRouter(router: Router): void {
	if (tracedRouters.has(router)) return
	tracedRouters.add(router)
	/** The origin of the navigation in progress. */
	let current: object | undefined

	router.beforeEach((to) => {
		// A redirect stays in the span its original location opened
		const origin = originOf(to)
		if (origin === current) return
		current = origin
		startNavigation(to.path)
	})

	router.afterEach((to, _from, failure) => {
		const origin = originOf(to)
		// Not the open span's navigation: a newer one already ended it as interrupted, an
		// earlier guard stopped this one before `beforeEach`, or it's a link to the page on screen
		if (origin !== current) return
		// Replaced by a navigation that ran no guards, like a link back to the page on screen
		if (failure && failure.type & CANCELLED) {
			interruptNavigation()
			return
		}
		// After Vue renders the new route, so what its `setup` starts nests under the span
		void nextTick(() => {
			if (origin === current) endNavigation(templateOf(to))
		})
	})

	// A guard that throws or a route chunk that fails to load skips `afterEach`
	router.onError((error: unknown, to: RouteLocationNormalized) => {
		if (originOf(to) === current) endNavigation(templateOf(to))
		captureException(error, { name: "vue_router.error" })
		// Vue Router logs errors only while no `onError` handler is registered
		console.error(error)
	})
}

/**
 * Report an error Vue caught, from a Nuxt `vue:error` hook, your own `app.config.errorHandler`,
 * or an `errorCaptured` hook that stops it. An error `traced` already recorded is skipped.
 */
export function reportVueError(error: unknown, _instance: unknown, info: string): void {
	captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
}

/**
 * `app.use(MapleVue)`: reports the errors Vue catches in components, watchers and event handlers,
 * which production builds only log. Vue still handles them, or the `errorHandler` set before it. Not for Nuxt.
 */
export const MapleVue: Plugin<[]> = {
	install(app: App) {
		const previous = app.config.errorHandler
		app.config.errorHandler = (error, instance, info) => {
			reportVueError(error, instance, info)
			if (previous) {
				previous(error, instance, info)
				return
			}
			// Back to Vue's own handling: it logs an error its handler throws, and in
			// development throws it on, as it does without a handler
			throw error
		}
	},
}

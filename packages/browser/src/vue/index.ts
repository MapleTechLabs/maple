// `@maple-dev/browser/vue`: Vue Router navigations and the errors Vue catches.
//
// Vue Router reports where a navigation starts (`beforeEach`) and where it's
// confirmed (`afterEach`), and Vue renders the new route on the next tick. A
// navigation span covers both, so the requests a page starts in `setup` nest
// under it. Works with Vue Router 4 and 5, and in Nuxt's client plugins.
import { type App, nextTick, type Plugin } from "vue"
import type { RouteLocationNormalized, Router } from "vue-router"
import { captureException } from "../errors"
import { endNavigation, startNavigation } from "../navigation"

/** `NavigationFailureType.cancelled | NavigationFailureType.duplicated`, the same in Vue Router 4 and 5. */
const REPLACED_OR_DUPLICATED = 8 | 16

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
		// Cancelled: a newer navigation already ended this one as interrupted.
		// Duplicated: a link to the current page, which runs no guards
		if (failure && failure.type & REPLACED_OR_DUPLICATED) return
		const origin = originOf(to)
		// After Vue renders the new route, so what its `setup` starts nests under the span.
		// Unless another navigation started since, or an earlier guard stopped this one
		// before `beforeEach` opened a span for it
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
 * which production builds only log. Keeps logging them, or calls the `errorHandler` set before it. Not for Nuxt.
 */
export const MapleVue: Plugin<[]> = {
	install(app: App) {
		const previous = app.config.errorHandler
		app.config.errorHandler = (error, instance, info) => {
			reportVueError(error, instance, info)
			// A handler replaces Vue's own logging
			if (previous) previous(error, instance, info)
			else console.error(error)
		}
	},
}

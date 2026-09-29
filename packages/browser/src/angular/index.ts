// `@maple-dev/browser/angular`: Angular Router navigations, resolvers and the
// errors Angular catches.
//
// The router reports every step of a navigation on `Router.events`: where it
// starts, redirects, is replaced, fails or finishes. Plain functions and a class
// without decorators, so apps consume this as ordinary ESM: it needs no Angular
// compiler or linker pass.
import { isPlatformBrowser } from "@angular/common"
import {
	type EnvironmentProviders,
	ErrorHandler,
	inject,
	PLATFORM_ID,
	provideEnvironmentInitializer,
} from "@angular/core"
import {
	type ActivatedRouteSnapshot,
	NavigationCancel,
	NavigationCancellationCode,
	NavigationEnd,
	NavigationError,
	NavigationSkipped,
	NavigationStart,
	RedirectCommand,
	Router,
} from "@angular/router"
import { captureException } from "../errors"
import { endNavigation, interruptNavigation, startNavigation, traced } from "../navigation"

/** Routers already traced: a second subscription would start every span twice. */
const tracedRouters = new WeakSet<Router>()

/**
 * Add to your app config's `providers`, next to `provideRouter`: a span for each navigation,
 * named after its route (`/projects/:id`). Does nothing during the server render.
 */
export function provideMapleTracing(): EnvironmentProviders {
	// An environment initializer, like the router's own `withDebugTracing`: it runs
	// before every app initializer, so it sees a navigation any of them starts,
	// like `withEnabledBlockingInitialNavigation()`'s first one
	return provideEnvironmentInitializer(() => {
		// Navigation state is module-level, which a server shares between requests
		if (!isPlatformBrowser(inject(PLATFORM_ID))) return
		const router = inject(Router)
		if (tracedRouters.has(router)) return
		tracedRouters.add(router)
		traceRouter(router)
	})
}

function traceRouter(router: Router): void {
	/** The latest navigation: an event from an older one never ends its span. */
	let current: number | undefined
	/** Whether the latest navigation redirected: the next one continues its span. */
	let redirecting = false

	router.events.subscribe((event) => {
		if (event instanceof NavigationStart) {
			current = event.id
			if (redirecting) redirecting = false
			else startNavigation(event.url.split(/[?#]/)[0])
			return
		}

		// A navigation to the URL on screen emits no NavigationStart
		if (event instanceof NavigationSkipped) {
			if (redirecting) {
				// A redirect to the page on screen: it landed there
				redirecting = false
				endNavigation(routeTemplate(router.routerState.snapshot.root))
			} else {
				// A click on the current URL still replaces a navigation in flight
				interruptNavigation()
			}
			return
		}

		const ended =
			event instanceof NavigationEnd ||
			event instanceof NavigationCancel ||
			event instanceof NavigationError
		if (!ended || event.id !== current) return

		if (event instanceof NavigationCancel) {
			// A guard's `UrlTree` or a resolver's `RedirectCommand` cancels the navigation
			// and starts a new one: both stay in one span, named after where it lands
			if (event.code === NavigationCancellationCode.Redirect) redirecting = true
			// A newer navigation replaced it: its NavigationStart ends this one as interrupted
			else if (event.code !== NavigationCancellationCode.SupersededByNewNavigation) endNavigation()
		} else if (event instanceof NavigationEnd) {
			endNavigation(routeTemplate(router.routerState.snapshot.root))
		} else {
			endNavigation(event.target && routeTemplate(event.target.root))
		}
	})
}

/**
 * The matched route's template, like `/projects/:id`: Angular has no full path
 * property, so the configured paths are joined from the root. The `**` route is `/**`.
 */
function routeTemplate(root: ActivatedRouteSnapshot): string {
	const paths: string[] = []
	for (let route: ActivatedRouteSnapshot | null = root; route; route = route.firstChild) {
		// Layout routes and `children` wrappers have an empty path
		if (route.routeConfig?.path) paths.push(route.routeConfig.path)
	}
	return `/${paths.join("/")}`
}

/**
 * Run a resolver's data loading in a span under the navigation. Errors are recorded once and
 * rethrown; a thrown `RedirectCommand` isn't one. Only requests started before `fn`'s first `await` nest under it.
 */
export function tracedResolver<T>(name: string, fn: () => Promise<T>): Promise<T> {
	return traced(name, fn, { isFailure: (error) => !(error instanceof RedirectCommand) })
}

/**
 * Report an error Angular caught, from your own `ErrorHandler`, `onViewError` or
 * `withNavigationErrorHandler`. An error `tracedResolver` already recorded is skipped.
 */
export function reportAngularError(error: unknown): void {
	captureException(error, { name: "angular.error" })
}

/**
 * `{ provide: ErrorHandler, useClass: MapleErrorHandler }`: reports the errors Angular catches in
 * templates, lifecycle hooks and listeners, then logs them as Angular's own handler does.
 */
export class MapleErrorHandler extends ErrorHandler {
	override handleError(error: unknown): void {
		reportAngularError(error)
		super.handleError(error)
	}
}

# Angular

Written against Angular 22 (standalone APIs), rxjs 7.8. Human version: https://maple.dev/docs/frontend/angular

## HttpClient must use fetch (check first)

The SDK only instruments `fetch`. Angular 22 `provideHttpClient()` uses fetch by default; `withXhr()` opts out (those requests aren't traced). Angular 21 and older default to XHR: add `withFetch()`:

```ts
provideHttpClient(withFetch()) // Angular 21 and older
```

## Init

`src/maple.ts` with the `MapleBrowser.init` call, imported first in `src/main.ts` (before `bootstrapApplication` / `bootstrapModule`). The CLI has no `import.meta.env`: inline the public key, or use the CLI's `define` option. `isDevMode()` works for `environment`. With `@angular/ssr`, `main.ts` is browser-only.

## Navigations

```ts
// src/app/router-tracing.ts
import { isPlatformBrowser } from "@angular/common"
import { inject, PLATFORM_ID, provideAppInitializer } from "@angular/core"
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
import { endNavigation, startNavigation, traced } from "../tracing"

export function provideRouterTracing() {
	// Runs before the router starts the first navigation
	return provideAppInitializer(() => {
		// Module-level navigation state must not be shared between SSR requests
		if (!isPlatformBrowser(inject(PLATFORM_ID))) return

		const router = inject(Router)
		let current: number | undefined
		let redirecting = false

		router.events.subscribe((event) => {
			if (event instanceof NavigationStart) {
				current = event.id
				// A redirect cancels the navigation and starts a new one: keep both in one span
				if (redirecting) {
					redirecting = false
					return
				}
				startNavigation(event.url.split(/[?#]/)[0])
				return
			}

			const ended =
				event instanceof NavigationEnd ||
				event instanceof NavigationCancel ||
				event instanceof NavigationError ||
				event instanceof NavigationSkipped
			// Only the latest navigation owns the span
			if (!ended || event.id !== current) return

			if (event instanceof NavigationCancel && event.code === NavigationCancellationCode.Redirect) {
				redirecting = true
			} else if (event instanceof NavigationEnd) {
				endNavigation(routeTemplate(router.routerState.snapshot.root))
			} else if (event instanceof NavigationError && event.target) {
				endNavigation(routeTemplate(event.target.root))
			} else {
				endNavigation()
			}
		})
	})
}

/** The matched route's template, like `/projects/:id`. */
function routeTemplate(root: ActivatedRouteSnapshot) {
	const segments: string[] = []
	for (let route: ActivatedRouteSnapshot | null = root; route; route = route.firstChild) {
		// Layout routes and `children` wrappers have an empty path
		if (route.routeConfig?.path) segments.push(route.routeConfig.path)
	}
	return `/${segments.join("/")}`
}

export const resolverSpan = <T>(name: string, fn: () => Promise<T>) =>
	traced(name, fn, (error) => !(error instanceof RedirectCommand))
```

Add `provideRouterTracing()` to the app config `providers` (or the root NgModule's `providers`), next to `provideRouter`. `provideAppInitializer` needs Angular 19+; on older versions use an `APP_INITIALIZER` factory provider.

- Guard `UrlTree` / `RedirectCommand` redirects: `NavigationCancel` with code `Redirect`, then a new `NavigationStart`; the `redirecting` flag keeps one span. Config `redirectTo` doesn't cancel.
- Same-URL navigation emits `NavigationSkipped` with no start. Query-only changes are navigations but don't rerun resolvers by default.

## Resolvers

```ts
export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	// inject() only works synchronously, before the first await
	const http = inject(HttpClient)
	const id = route.paramMap.get("id")

	return resolverSpan("resolve /projects/:id", () =>
		Promise.all([
			firstValueFrom(http.get<Project>(`/api/projects/${id}`)),
			firstValueFrom(http.get<Member[]>(`/api/projects/${id}/members`)),
		]),
	)
}
```

- `firstValueFrom` subscribes immediately and the fetch backend calls `fetch()` synchronously, so requests nest under the span.
- Nested routes' resolvers run level by level (parent before child).
- Data loaded in components (`httpResource`, `ngOnInit`) runs after `NavigationEnd`: separate traces. Don't wrap those; mention it in the hand-off if the app relies on it.

## Caught errors

Angular sends template, lifecycle and listener errors (and `RouterLink` navigation rejections) to `ErrorHandler`, never `window.onerror`:

```ts
@Injectable()
export class MapleErrorHandler extends ErrorHandler {
	override handleError(error: unknown) {
		// Resolver errors are already on their resolver span
		if (!alreadyRecorded(error)) MapleBrowser.captureException(error, { name: "angular.error" })
		super.handleError(error)
	}
}
```

Provide it with `{ provide: ErrorHandler, useClass: MapleErrorHandler }`. If the app already has a custom `ErrorHandler`, add the capture call to it instead. If it implements `onViewError` (`@boundary` blocks, Angular 22), report there too. A `withNavigationErrorHandler` that returns a `RedirectCommand` hides errors from `ErrorHandler`: report inside it.

## SSR (@angular/ssr)

Start the Node SDK per `maple-nodejs-style`, preloaded with `node --import ./tracing.mjs dist/<project>/server/server.mjs`. Wrap the render middleware at the bottom of `src/server.ts`:

```ts
app.use((req, res, next) => {
	tracer.startActiveSpan("ssr", { attributes: { "url.path": req.path } }, async (span) => {
		try {
			const response = await angularApp.handle(req)
			if (!response) return next()

			const carrier: Record<string, string> = {}
			propagation.inject(context.active(), carrier)
			if (carrier["traceparent"]) {
				response.headers.append("server-timing", `traceparent;desc="${carrier["traceparent"]}"`)
			}

			await writeResponseToNodeResponse(response, res)
		} catch (error) {
			next(error)
		} finally {
			span.end()
		}
	})
})
```

- The span name is fixed (Express doesn't know the Angular route); the browser's `pageload <template>` span carries the template.
- `provideClientHydration()` replays SSR GET requests, so first-load resolver spans in the browser have no fetch children.
- Don't install `ZoneContextManager`: new apps are zoneless, and the fetch backend runs outside the zone anyway.

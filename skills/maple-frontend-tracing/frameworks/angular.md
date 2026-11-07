# Angular

Tested with Angular 22.2 (standalone; zoneless and zone.js; `@angular/ssr` with Express), `@maple-dev/browser` 0.14.0. Human version: https://maple.dev/docs/frontend/angular

There is no `@maple-dev/browser/angular` entry. Wire `Router.events`, resolvers and `ErrorHandler` to the core API with the files below. Needs Angular 19+ (`provideEnvironmentInitializer`); below that, tell the user to upgrade.

## Install and init

Install `@maple-dev/browser` and `@opentelemetry/api` (resolver await fix, error handler, SSR). Create `src/maple.ts` with the `MapleBrowser.init` call from `SKILL.md` Step 2 and import it first in `src/main.ts`, before `bootstrapApplication` / `bootstrapModule`. The CLI has no `import.meta.env`: inline the public key; use `environment: isDevMode() ? "development" : "production"`. With `@angular/ssr`, `main.ts` is browser-only.

`HttpClient` is traced with both backends (default fetch, and `withXhr()`): the SDK instruments `fetch` and `XMLHttpRequest`. Don't change the backend.

## Navigations

Create `src/app/maple-tracing.ts` exactly like this:

```ts
import { inject, NgZone, provideEnvironmentInitializer } from "@angular/core"
import {
	type ActivatedRouteSnapshot,
	NavigationCancel,
	NavigationCancellationCode,
	NavigationEnd,
	NavigationError,
	NavigationSkipped,
	NavigationStart,
	Router,
	RoutesRecognized,
} from "@angular/router"
import { MapleBrowser } from "@maple-dev/browser"

/** `/projects/:id`: the configured paths of the matched routes, joined. */
function routeTemplate(route: ActivatedRouteSnapshot | null): string {
	const paths: string[] = []
	for (; route; route = route.firstChild) if (route.routeConfig?.path) paths.push(route.routeConfig.path)
	return `/${paths.join("/")}`
}

export function provideMapleTracing() {
	return provideEnvironmentInitializer(() => {
		const router = inject(Router)
		const zone = inject(NgZone)
		let route: string | undefined
		let redirected = false
		router.events.subscribe((event) =>
			// Outside Angular's zone, so the SDK's export timer doesn't hold up isStable (zone.js apps)
			zone.runOutsideAngular(() => {
				if (event instanceof NavigationStart) {
					// A guard or resolver redirect continues the span of the navigation it cancelled
					if (!redirected) MapleBrowser.startNavigation(event.url.split(/[?#]/)[0])
					redirected = false
					route = undefined
				} else if (event instanceof RoutesRecognized) {
					route = routeTemplate(event.state.root)
				} else if (event instanceof NavigationEnd || event instanceof NavigationError) {
					MapleBrowser.endNavigation(route)
				} else if (event instanceof NavigationCancel) {
					if (event.code === NavigationCancellationCode.Redirect) redirected = true
					// Superseded: the next startNavigation() ends it as interrupted
					else if (event.code !== NavigationCancellationCode.SupersededByNewNavigation)
						MapleBrowser.endNavigation(route)
				} else if (event instanceof NavigationSkipped) {
					// Back to the URL on screen: a redirect to it, or a click on it during another navigation
					MapleBrowser.endNavigation()
					redirected = false
				}
			}),
		)
	})
}
```

Add `provideMapleTracing()` and `{ provide: ErrorHandler, useClass: MapleErrorHandler }` to the app config `providers` (or the root NgModule's), keeping the existing ones and `provideBrowserGlobalErrorListeners()`.

- Names: `navigate /projects/:id`, nested paths joined (`/orgs/:org/projects/:id`), wildcard `/**`, `url.path` without query/fragment.
- Guard `UrlTree`, resolver `RedirectCommand` and config `redirectTo`: one span named after the destination, `url.path` = the requested URL.
- Click during a pending navigation: old span bare `navigate` with `maple.navigation.interrupted: true`; its resolver span finishes later (Angular doesn't cancel it).
- Click on the URL on screen: no span. A pending navigation that ends there: bare `navigate`.
- Query-only, fragment, back/forward: a `navigate` span each; no resolver span unless path/matrix params changed.
- `NavigationError`, guard `false`: span named after the target, not Error.

## Resolvers

Wrap each route resolver's data loading in `MapleBrowser.traced("loader <route path>", fn)`. Call `inject()` before `traced`. Use `firstValueFrom(http.get(...))`; start independent requests together with `Promise.all`:

```ts
export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	const http = inject(HttpClient) // inject() only works before the first await
	const id = route.paramMap.get("id")

	return MapleBrowser.traced("loader /projects/:id", () =>
		Promise.all([
			firstValueFrom(http.get<Project>(`https://api.acme.com/projects/${id}`)),
			firstValueFrom(http.get<Member[]>(`https://api.acme.com/projects/${id}/members`)),
		]),
	)
}
```

- A request after an `await` inside `fn` is a separate trace. For dependent requests: `const ctx = context.active()` before the first `await`, then `await context.with(ctx, () => firstValueFrom(...))`. zone.js doesn't help.
- API 404 → not-found page: inject `Router` before `traced`, catch `HttpErrorResponse` with `status === 404` inside `fn`, `return new RedirectCommand(router.parseUrl("/not-found"), { skipLocationChange: true })`. Loader span stays Ok; the 404 fetch span is Error (4xx rule, no issue).
- Don't wrap component-level loading (`ngOnInit`, `httpResource`): it runs after `NavigationEnd`, as its own trace.
- zone.js apps only: `return inject(NgZone).runOutsideAngular(() => MapleBrowser.traced(...))`, or `ApplicationRef.isStable` stays false ~2 s after each navigation (the export timer lands in Angular's zone).

## Errors

Create `src/app/maple-error-handler.ts`:

```ts
import { ErrorHandler, Injectable } from "@angular/core"
import { MapleBrowser } from "@maple-dev/browser"
import { SpanStatusCode, trace } from "@opentelemetry/api"

@Injectable()
export class MapleErrorHandler extends ErrorHandler {
	override handleError(error: unknown): void {
		MapleBrowser.captureException(error, { name: "angular.error" })
		// During the server render captureException does nothing: record it on the request's span
		const span = typeof window === "undefined" ? trace.getActiveSpan() : undefined
		if (span && error instanceof Error) {
			span.recordException(error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
		}
		super.handleError(error)
	}
}
```

If the app already provides an `ErrorHandler`, add these lines to its `handleError` instead of providing a second one (the last provider wins). No dedupe code: `captureException` skips errors `traced` or the SDK's global handlers already recorded.

## SSR (@angular/ssr)

Start the Node SDK per `maple-nodejs-style` in a plain-JS `tracing.mjs` with its ES module `register()` hook, and run `node --import ./tracing.mjs dist/<project>/server/server.mjs`. Express is bundled into `server.mjs`, so only the HTTP (request spans, `GET`) and undici (server-side `HttpClient`) instrumentations apply. In `src/server.ts`, at the top of the render middleware (the `app.use` that calls `angularApp.handle`):

```ts
import { context, propagation } from "@opentelemetry/api"

app.use((req, res, next) => {
	// The request's trace context, so the browser's pageload span joins this trace
	const carrier: { traceparent?: string } = {}
	propagation.inject(context.active(), carrier)
	if (carrier.traceparent) res.setHeader("server-timing", `traceparent;desc="${carrier.traceparent}"`)

	angularApp
		.handle(req)
		.then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
		.catch(next)
})
```

- `pageload <template>` becomes a child of the server's `GET` span; server `HttpClient` requests and the API's spans are in the same trace. No header under `ng serve` (no Node SDK) or on static assets.
- `provideClientHydration()` replays successful server responses: the browser's first resolver span has no fetch children.
- Full load of a guard-redirected URL: HTTP 302; `pageload` joins the target page's trace.
- Resolver throws during SSR: Express 404, no `pageload`; `MapleErrorHandler` records it on the server's request span (status Error). A component render error is reported twice (server span + browser `angular.error`).
- Rendered HTML has no `ETag`. Don't add the header to HTML a CDN caches.

## Check

In addition to `SKILL.md` Step 7 (Angular's caught-handler span is `angular.error`):

- Reload a resolver route: one `pageload /projects/:id`; with SSR its `parentSpanId` is the server `GET` span and the `document` response has `server-timing: traceparent;desc="00-…"`.
- Click a resolver route: `navigate /projects/:id` → `loader /projects/:id` → `GET` fetch/XHR spans (by `parentSpanId`) → API spans in the same `traceId`.
- Guard redirect: one span named after the destination, `url.path` = original URL, no `maple.navigation.interrupted` span.
- Resolver that throws: exactly one `exception` event (on the loader span), no `angular.error`. `(click)` handler that throws: one `angular.error`, no `browser.uncaught_error`.
- zone.js apps: `ApplicationRef.isStable` emits `true` within ~100 ms of a navigation, not ~2 s.

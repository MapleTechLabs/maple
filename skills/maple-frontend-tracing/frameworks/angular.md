# Angular

Written against Angular 22 (standalone APIs), rxjs 7.8, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/angular

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/angular` (router, resolvers, errors) and `@maple-dev/browser/angular/server` (SSR render). Needs Angular 19+ (`provideEnvironmentInitializer`); below that, tell the user to upgrade, or follow `frameworks/other.md` with `MapleBrowser.*` from `Router.events`. The entry is plain ESM (no decorators, no Angular compiler or linker step).

## HttpClient must use fetch (check first)

The SDK only instruments `fetch`. Angular 22 `provideHttpClient()` uses fetch by default; `withXhr()` opts out (those requests aren't traced). Angular 21 and older default to XHR: add `withFetch()`:

```ts
provideHttpClient(withFetch()) // Angular 21 and older
```

## Init

`src/maple.ts` with the `MapleBrowser.init` call, imported first in `src/main.ts` (before `bootstrapApplication` / `bootstrapModule`). The CLI has no `import.meta.env`: inline the public key, or use the CLI's `define` option. `isDevMode()` works for `environment`. With `@angular/ssr`, `main.ts` is browser-only.

## Navigations and caught errors

```ts
// src/app/app.config.ts
import { MapleErrorHandler, provideMapleTracing } from "@maple-dev/browser/angular"

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideRouter(routes),
		provideHttpClient(),
		provideMapleTracing(),
		{ provide: ErrorHandler, useClass: MapleErrorHandler },
	],
}
```

Merge into the existing `providers` (or the root NgModule's `providers`); keep the existing ones. Don't hand-write a `Router.events` subscription.

- `provideMapleTracing()`: an environment initializer (runs before app initializers, so it sees a navigation one of them starts). Does nothing on the server. Idempotent per router. Handles router events outside Angular's zone.
- Names: joined `routeConfig.path` of the activated routes (`/projects/:id`, `/**` for the wildcard, empty layout paths skipped). Routes matched by a `matcher` function have no `path` and add nothing to the name.
- Guard `UrlTree` / resolver `RedirectCommand`: one span named after the target (`/old` → `navigate /projects/:id`, `url.path` `/old`); a redirect to the URL on screen ends the span named after that route. Config `redirectTo` doesn't cancel. With SSR, a full load of a redirecting URL is an HTTP 302 and the `pageload` joins the target page's render.
- A click during a pending navigation (including a click on the URL on screen) ends the old span as a bare `navigate` with `app.navigation.interrupted: true`. Its resolver span can outlive it (Angular ignores the result, doesn't stop it).
- Same-URL navigation (`NavigationSkipped`): no span. Query-only changes, `routerLink` fragments and back/forward: a `navigate <template>` span each; resolvers rerun only when path or matrix params change (by default).
- `NavigationError`: span named, not marked Error; the error is on the resolver span or an `angular.error` span.
- `url.path` is the router URL: no `<base href>`, matrix params kept.
- `MapleErrorHandler`: reports template, lifecycle and listener errors (and `RouterLink` navigation rejections) as `angular.error`, then logs like Angular's handler. A throwing `(click)` handler gives one `angular.error`, not `browser.uncaught_error`. Skips errors `tracedResolver` recorded, and the wrapped cross-origin `Script error.` events `provideBrowserGlobalErrorListeners()` forwards (the SDK's window handler has them). Keep `provideBrowserGlobalErrorListeners()`.
- The app already provides an `ErrorHandler`: keep it, don't add `MapleErrorHandler`; call `reportAngularError(error)` first in its `handleError`. (`provideMapleTracing()` doesn't provide one because the last `ErrorHandler` provider wins.)
- `onViewError` implemented (`@boundary` blocks, Angular 22): call `reportAngularError(error)` there too. A `withNavigationErrorHandler` that returns a `RedirectCommand` hides errors from `ErrorHandler`: call `reportAngularError(event.error)` inside it.

## Resolvers

```ts
import { tracedResolver } from "@maple-dev/browser/angular"

export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	// inject() only works synchronously, before the first await
	const http = inject(HttpClient)
	const id = route.paramMap.get("id")

	return tracedResolver("loader /projects/:id", () =>
		Promise.all([
			firstValueFrom(http.get<Project>(`/api/projects/${id}`)),
			firstValueFrom(http.get<Member[]>(`/api/projects/${id}/members`)),
		]),
	)
}
```

- `tracedResolver` = `MapleBrowser.traced` where a thrown `RedirectCommand` isn't a failure. Errors are recorded once and rethrown.
- `firstValueFrom` subscribes immediately and the fetch backend calls `fetch()` synchronously, so requests nest under the span. Sequential `await`s: the `await` rule in `SKILL.md` Step 4.
- API 404 → not-found page: catch the `HttpErrorResponse` inside the function and `return new RedirectCommand(router.parseUrl("/not-found"), { skipLocationChange: true })` (inject `Router` before the span). The loader span stays Ok; the 404 `fetch` span is Error (4xx rule).
- Nested routes' resolvers run level by level (parent before child).
- Data loaded in components (`httpResource`, `ngOnInit`) runs after `NavigationEnd`: separate traces. Don't wrap those; mention it in the hand-off if the app relies on it.

## SSR (@angular/ssr)

Start the Node SDK per `maple-nodejs-style` (bootstrap snippet in https://github.com/MapleTechLabs/maple/tree/main/skills/maple-nodejs-style if that skill isn't installed) in a plain-JS `telemetry.mjs` at the project root, with the ES module hook registered before `sdk.start()` (`register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` from `node:module`), and run the server with `node --import ./telemetry.mjs dist/<project>/server/server.mjs`. The CLI bundles Express into `server.mjs`, so Express instrumentation can't patch it: `@opentelemetry/instrumentation-http` (server spans, named `GET`) and `@opentelemetry/instrumentation-undici` (server-side `HttpClient` requests) are the ones that apply. Wrap the render in the middleware at the bottom of `src/server.ts`:

```ts
import { tracedRender } from "@maple-dev/browser/angular/server"

app.use((req, res, next) => {
	tracedRender(req, () => angularApp.handle(req))
		.then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
		.catch(next)
})
```

- `tracedRender`: an `ssr` span (fixed name, `url.path` attribute) under the HTTP request span, plus `Server-Timing` on the response; the browser's `pageload <template>` is its child. It ends when `handle()` resolves (app stable), before the HTML is written. A thrown render error is recorded on it and rethrown. `/angular/server` imports only `@opentelemetry/api`.
- Resolver spans run on the server too and nest under `ssr` with their fetch spans (Node keeps async context).
- `MapleErrorHandler` also runs on the server and records into the `ssr` trace. A render error on a full page load is reported twice: once by the server render, once by hydration.
- A resolver that throws during SSR makes `handle()` resolve `null`: Express answers 404, no app HTML, no `pageload`. The error is on the server's resolver span. `tracedRender` opens an `ssr` span for every request it sees, rendered or not.
- Rendered HTML has no `ETag`, so reloads get a new trace. CDN-cached HTML: render those pages with `angularApp.handle(req)` directly, without `tracedRender`, or every visitor joins one trace.
- `provideClientHydration()` replays SSR GET requests, so first-load resolver spans in the browser have no fetch children.

## Gotchas

- Don't install `ZoneContextManager`: new apps are zoneless, and the fetch backend runs outside the zone anyway.
- zone.js apps: a resolver span ends inside the zone and starts the exporter's 2 s timer, so `ApplicationRef.isStable` stays `false` for up to 2 s after a navigation with resolvers (delays e.g. the service worker's default registration). Zoneless apps aren't affected. Mention it in the hand-off for zone.js apps.
- Lazy route chunk downloads count toward the navigation span with no child span.
- `HttpErrorResponse` isn't an `Error`: the resolver span records its message; the fetch span has the status and URL.

## Check

Production build (`ng build`, then `node --import ./telemetry.mjs dist/<project>/server/server.mjs` with SSR), in addition to `SKILL.md` Step 7:

- SSR page load `/projects/1`: `GET` → `ssr` → `loader /projects/:id` → `fetch` → API, and `pageload /projects/:id` under `ssr`; `server-timing` on the HTML only (not JS/CSS); a reload gives a new trace.
- Click: `navigate /projects/:id` → `loader /projects/:id` → `fetch` spans. A guard redirect (`/old`): one span named after the target, `url.path=/old`.
- A resolver that throws: one `exception` event (on the loader span), no extra `angular.error`. A throwing `(click)` handler: one `angular.error`.

---
title: "Frontend tracing for Angular"
description: "Trace Angular Router navigations, resolvers and HttpClient requests as OpenTelemetry traces linked to your backend, report errors Angular's ErrorHandler catches, and join the @angular/ssr render to the browser page load."
group: "Frontend"
order: 6
navLabel: "Angular"
icon: "angular"
---

This page connects an Angular app to Maple with `@maple-dev/browser`: one span per Router navigation, named after the route path, a span per resolver with its `HttpClient` requests under it, and the backend spans behind those, all in one trace. With `@angular/ssr`, the browser's page load also joins the trace of the server render.

The SDK has no Angular-specific entry, so you add two small files that connect `Router.events` and `ErrorHandler` to it. It needs Angular 19 or later (for `provideEnvironmentInitializer`), and was tested with Angular 22.2 (standalone, zoneless and zone.js) and `@maple-dev/browser` 0.14.0.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Angular.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install and initialize

```bash
npm install @maple-dev/browser @opentelemetry/api
```

Initialize the SDK in its own file:

```ts
// src/maple.ts
import { isDevMode } from "@angular/core"
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public key, safe to ship in the bundle
	serviceName: "acme-web",
	environment: isDevMode() ? "development" : "production",
	tracing: {
		// APIs on another origin that should receive `traceparent`
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Import it first in `src/main.ts`, so it runs before Angular bootstraps:

```ts
// src/main.ts
import "./maple"
import { bootstrapApplication } from "@angular/platform-browser"
import { App } from "./app/app"
import { appConfig } from "./app/app.config"

bootstrapApplication(App, appConfig).catch((err) => console.error(err))
```

`init()` instruments `fetch` and `XMLHttpRequest`, so `HttpClient` is traced with its default fetch backend and with `withXhr()`. It also records uncaught errors and starts session replay. For an EU organization add `region: "eu"`. With `@angular/ssr`, `main.ts` is the browser entry only. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your API

Requests to the page's own origin carry a W3C `traceparent` header, so your backend's spans join the browser's trace. For an API on another origin, list it in `propagateTraceHeaderCorsUrls`, as above, and allow the header in the API's CORS preflight:

```http
Access-Control-Allow-Headers: content-type, traceparent
```

Only list your own APIs: third parties would receive your trace ids, and many reject the preflight. The backend needs an OpenTelemetry HTTP server instrumentation to read the header; see [Instrument your application](/docs/instrumentation).

## Router navigations

`provideMapleTracing()` turns each Router navigation into a span: `pageload` for the first, `navigate` after that, named after the matched route's path.

```ts
// src/app/maple-tracing.ts
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

Add it to the app config, with the error handler from [Errors](#errors-angular-catches):

```ts
// src/app/app.config.ts
import { type ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from "@angular/core"
import { provideClientHydration } from "@angular/platform-browser"
import { provideRouter } from "@angular/router"
import { routes } from "./app.routes"
import { MapleErrorHandler } from "./maple-error-handler"
import { provideMapleTracing } from "./maple-tracing"

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideRouter(routes),
		provideClientHydration(), // only with @angular/ssr
		provideMapleTracing(),
		{ provide: ErrorHandler, useClass: MapleErrorHandler },
	],
}
```

An environment initializer runs before the first navigation, so the page load is traced too. For an NgModule app, add the same providers to the root module. What you get:

- **Names use the route config, not the URL.** Nested routes join their paths (`navigate /orgs/:org/projects/:id`), empty layout paths add nothing, and the wildcard route is `navigate /**`. The concrete path, without query or fragment, is the `url.path` attribute.
- **A redirect is one span.** A guard that returns a `UrlTree`, a resolver that returns a `RedirectCommand`, and a `redirectTo` in the config each give one span named after the destination, with `url.path` set to the URL the user asked for.
- **A click during a pending navigation interrupts it.** The old span ends with the bare name `navigate` and `maple.navigation.interrupted: true`. Angular doesn't cancel its resolver, so the resolver's span and request finish after it.
- **The URL already on screen.** A click on it starts no span. A pending navigation that ends there (a click on it, or a redirect to it) ends with the bare name `navigate`.
- **Query-only changes, fragments and back/forward** each get a `navigate` span. Resolvers only rerun when path or matrix params change, so a query-only change has no resolver span under it.
- **Failed navigations aren't marked `Error`.** A `NavigationError` or a guard returning `false` ends the span, named after the route it tried to reach. The error itself is on the resolver's span.

## Resolvers

Resolvers are Angular's route-level data loading: the router waits for them, so their time is navigation time. Wrap each one in `MapleBrowser.traced`, named `loader <route path>`, so its requests nest under the navigation:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient } from "@angular/common/http"
import { inject } from "@angular/core"
import type { ResolveFn } from "@angular/router"
import { MapleBrowser } from "@maple-dev/browser"
import { firstValueFrom } from "rxjs"
import type { Member, Project } from "./project"

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

The resolver span is a child of the navigation span, and both `HttpClient` requests are its children: `firstValueFrom` subscribes at once, and `HttpClient` starts the request during the subscribe. A resolver that throws marks its span `Error` with the exception, once.

The browser has no async context, so only requests started before the first `await` nest under the span; a later one starts a trace of its own. For a request that depends on an earlier one, keep the context and run it inside:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient } from "@angular/common/http"
import { inject } from "@angular/core"
import type { ResolveFn } from "@angular/router"
import { MapleBrowser } from "@maple-dev/browser"
import { context } from "@opentelemetry/api"
import { firstValueFrom } from "rxjs"
import type { Member, Project } from "./project"

export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	const http = inject(HttpClient)
	const id = route.paramMap.get("id")

	return MapleBrowser.traced("loader /projects/:id", async () => {
		const ctx = context.active() // before the first await
		const project = await firstValueFrom(http.get<Project>(`https://api.acme.com/projects/${id}`))
		const members = await context.with(ctx, () =>
			firstValueFrom(http.get<Member[]>(`https://api.acme.com/projects/${project.id}/members`)),
		)
		return [project, members]
	})
}
```

zone.js doesn't carry the context across `await` either.

To show a not-found page for a missing record, catch the 404 inside the traced function and return a `RedirectCommand`:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient, HttpErrorResponse } from "@angular/common/http"
import { inject } from "@angular/core"
import { RedirectCommand, type ResolveFn, Router } from "@angular/router"
import { MapleBrowser } from "@maple-dev/browser"
import { firstValueFrom } from "rxjs"
import type { Project } from "./project"

export const projectResolver: ResolveFn<Project | RedirectCommand> = (route) => {
	const http = inject(HttpClient)
	const router = inject(Router)
	const id = route.paramMap.get("id")

	return MapleBrowser.traced("loader /projects/:id", async () => {
		try {
			return await firstValueFrom(http.get<Project>(`https://api.acme.com/projects/${id}`))
		} catch (error) {
			if (error instanceof HttpErrorResponse && error.status === 404) {
				return new RedirectCommand(router.parseUrl("/not-found"), { skipLocationChange: true })
			}
			throw error
		}
	})
}
```

The resolver span stays `Ok`, and the navigation span is `navigate /not-found` with the requested path in `url.path`. The 404 request's span is marked `Error`, as OpenTelemetry marks every 4xx client span, but Maple doesn't open an issue for it.

## Errors Angular catches

Angular catches errors from templates, lifecycle hooks and event listeners and hands them to `ErrorHandler`, so they never reach the SDK's global handlers. Report them from your own:

```ts
// src/app/maple-error-handler.ts
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

If your app already has an `ErrorHandler`, add these lines to it instead. Each error is reported once:

- A `(click)` handler that throws is one `angular.error` span.
- A resolver that throws is recorded on its span. `RouterLink` passes the same error to `ErrorHandler`, and `captureException` skips errors already recorded.
- Uncaught errors and unhandled rejections are `browser.uncaught_error` and `browser.unhandled_rejection` spans. `provideBrowserGlobalErrorListeners()` forwards them to `ErrorHandler` too, and `captureException` skips them.

## Server-side rendering

With `@angular/ssr`, the first page load starts on your Node server. Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), keeping its `register()` call since the server build is an ES module, and preload it:

```bash
node --import ./tracing.mjs dist/acme-web/server/server.mjs
```

The HTTP instrumentation creates a span per request, and the undici instrumentation traces the `HttpClient` requests made during the render. Then send the request's trace context to the browser, in the render middleware of `src/server.ts`:

```ts
// src/server.ts
import { context, propagation } from "@opentelemetry/api"

// ...the generated imports, express.static() and your API routes

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

The browser's `pageload` span reads the `Server-Timing` header and becomes a child of the server's request span. Without the Node SDK, for example under `ng serve`, no header is sent. What the first load looks like:

- **One trace from the request to the page.** The server's `HttpClient` requests are children of the request span, and the API's spans are under those.
- **The browser's first resolver has no requests under it.** `provideClientHydration()` replays the server's successful `HttpClient` responses; a failed one, like a 404, is requested again.
- **A redirect is a 302.** A full load of a URL a guard redirects gets a `302`, and the `pageload` span joins the trace of the page it lands on.
- **A resolver that throws during the render gets no page.** `handle()` resolves `null` and Express answers `404`, so there's no `pageload`. `MapleErrorHandler` records the error on the server's request span and marks it `Error`.
- **A component that throws while rendering is reported twice**: on the server's request span, and as an `angular.error` span when the browser renders it again.

`@angular/ssr` sends no `ETag` on rendered HTML, so a reload is a new render with a new trace. Don't send the header on HTML a CDN caches, or every visitor's page load joins the same trace.

## zone.js apps

New Angular apps are zoneless. With zone.js, the SDK starts its 2-second export timer from whatever zone ends a span, and a timer in Angular's zone keeps `ApplicationRef.isStable` false until it fires. `provideMapleTracing()` already runs outside the zone. Start each resolver's `traced` call outside it too, with `return inject(NgZone).runOutsideAngular(() => MapleBrowser.traced(...))`. The router still resumes in Angular's zone, so change detection runs as before.

## Next steps

- [Browser SDK reference](/docs/session-replay/browser-sdk): sampling, privacy, logs, Web Vitals and every `init()` option.
- [Frontend tracing overview](/docs/frontend): the other framework guides.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

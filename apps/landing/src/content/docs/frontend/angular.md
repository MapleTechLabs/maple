---
title: "Frontend tracing for Angular"
description: "Trace every Angular Router navigation, resolver and HttpClient request as one OpenTelemetry trace, linked to your backend, your server render and session replay."
group: "Frontend"
order: 6
navLabel: "Angular"
icon: "angular"
---

Angular's router reports every step of a navigation on one observable, `Router.events`, so you can see when a navigation starts, redirects, fails or finishes without patching anything. This guide turns a click on a `routerLink` into one trace with a span for the navigation, a span per resolver, the `HttpClient` requests those resolvers made, and the backend spans behind them. With `@angular/ssr`, the first page load also includes the server render. The integration needs Angular 19 or later, and the code was checked against Angular 22 with standalone APIs.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Angular.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser
```

This guide needs `@maple-dev/browser` 0.10.0 or later.

Initialize the SDK in its own file and import it first in `src/main.ts`, so it's running before Angular creates anything:

```ts
// src/maple.ts
import { isDevMode } from "@angular/core"
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public key, safe to ship in the bundle
	serviceName: "acme-web",
	environment: isDevMode() ? "development" : "production",
})
```

```ts
// src/main.ts
import "./maple" // first, so the SDK is running before Angular bootstraps
import { bootstrapApplication } from "@angular/platform-browser"
import { App } from "./app/app"
import { appConfig } from "./app/app.config"

bootstrapApplication(App, appConfig).catch((err) => console.error(err))
```

The Angular CLI has no `import.meta.env`, so this file doesn't use it. The key is public, so a literal is fine, or use the CLI's `define` option. With `@angular/ssr`, `main.ts` is the browser entry only, so this never runs on the server.

`init()` sets up:

- a span for every `fetch()` call;
- error spans for uncaught errors and unhandled promise rejections, which show up on the [Errors](/docs/errors/overview) page;
- session replay, with the same `session.id` on every span and replay event, so a trace links to the recording of the session that produced it;
- export every 2 seconds, plus a flush when the tab is hidden or closed, so the spans from the last moments of a visit aren't lost;
- redaction of credential-looking query parameters (`token`, `code`, `password` and similar) in every URL it sends.

Use the public ingest key (`maple_pk_…`) from **Settings → Ingestion**. It can only write telemetry, so it's safe in browser code. For an EU organization, add `region: "eu"`. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

### Make sure HttpClient uses fetch

This decides whether you see any network spans at all. The browser SDK instruments `fetch`, not `XMLHttpRequest`, and `HttpClient` can use either.

Since Angular 22, `provideHttpClient()` uses `fetch` by default. On Angular 21 and older, the default is `XMLHttpRequest`, so every `HttpClient` request is invisible to the SDK: no span, and no `traceparent` header for your backend. Switch it to `fetch`:

```ts
// src/app/app.config.ts (Angular 21 and older)
import { provideHttpClient, withFetch } from "@angular/common/http"
import type { ApplicationConfig } from "@angular/core"

export const appConfig: ApplicationConfig = {
	providers: [
		// Angular 21 and older default to XMLHttpRequest, which the SDK doesn't trace
		provideHttpClient(withFetch()),
	],
}
```

On Angular 22, the same goes for `withXhr()`: if you added it for upload progress events, those requests aren't traced.

## Connect browser traces to your backend

Each `fetch()` span sends a W3C `traceparent` header, and your backend's span joins the same trace. For requests to the page's own origin this happens automatically. For an API on another origin, list it:

```ts
MapleBrowser.init({
	// ...
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Then allow the header in the API's CORS configuration. Without it, the browser blocks the request after the preflight:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent, tracestate
```

Only list your own APIs. Sending `traceparent` to third parties leaks your trace ids, and many of them reject the preflight.

Your backend needs OpenTelemetry to read the header; every OpenTelemetry HTTP server instrumentation does. See [Instrument your application](/docs/instrumentation) for your backend's language or framework.

Browser and server clocks disagree, so a server span can appear to start slightly before the `fetch` that caused it, and a laptop that slept can be minutes off. Durations are accurate; the offsets between browser and server spans are approximate.

## Navigation and data-loading spans

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The SDK fixes that with a span per navigation, and the data-loading and `fetch` spans nested under it. Three calls do the work:

- `MapleBrowser.startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `MapleBrowser.endNavigation(route)` names the span after the route template and ends it.
- `MapleBrowser.traced(name, fn, { isFailure })` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`. An error it recorded isn't reported a second time by `captureException` or the SDK's global error handlers.

The Angular integration below connects them to the Angular Router and your resolvers.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

The first page load joins the server render's trace without any browser code: when the server sends its trace context in a `Server-Timing` header or a `<meta name="traceparent">` tag, the `pageload` span becomes part of that trace, and follows its sampling decision: a page load under a trace the server didn't sample isn't recorded. In a client-only app, it starts a trace of its own. The [Browser SDK reference](/docs/session-replay/browser-sdk#navigation-and-data-loading-spans) has the details.

### The await problem

In the browser, a span only stays active until the first `await` inside it. A request that starts after an `await` loses its parent and shows up as a separate trace.

```ts
// ❌ fetchMembers starts after an await, so it becomes its own trace
MapleBrowser.traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id)
	return { project, members }
})
```

```ts
// ✅ Save the context before the first await, and run later requests inside it
import { context } from "@opentelemetry/api"

MapleBrowser.traced("load project", async () => {
	const ctx = context.active()
	const project = await fetchProject(id)
	const members = await context.with(ctx, () => fetchMembers(project.id))
	return { project, members }
})
```

`context` comes from `@opentelemetry/api`, so add it with `npm install @opentelemetry/api` if you use this pattern. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

If the requests don't depend on each other, start them together with `Promise.all` instead. Both nest under the span, and the page stops waiting on one request before starting the next.

This happens because browsers have no equivalent of Node's `AsyncLocalStorage`, which is what carries the active span across `await` on the server.

## Trace Angular Router navigations

Every navigation emits a `NavigationStart`. When it's over, it emits `NavigationEnd` if the new route's components were created, `NavigationCancel` if a guard said no, something redirected, or a newer navigation replaced it, and `NavigationError` if something threw. `provideMapleTracing()` turns those events into a span per navigation. Add it next to the router, together with the error handler from [the errors section](#report-errors-caught-by-angulars-errorhandler):

```ts
// src/app/app.config.ts
import { provideHttpClient } from "@angular/common/http"
import { type ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from "@angular/core"
import { provideRouter } from "@angular/router"
import { MapleErrorHandler, provideMapleTracing } from "@maple-dev/browser/angular"
import { routes } from "./app.routes"

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

`provideMapleTracing()` subscribes to `Router.events` from an environment initializer. Those run before every app initializer, so it also sees a navigation that an app initializer starts, like the first one with `withEnabledBlockingInitialNavigation()`. During the server render it does nothing, since the render gets [a span of its own](#trace-server-rendering-with-angularssr).

How navigations turn into spans:

- **The span name comes from `routeConfig.path`, not from the URL.** Angular has no single "full path" property, so the integration walks the activated routes from the root and joins their configured paths. Nested routes like `{ path: "projects", children: [{ path: ":id" }] }` come out as `/projects/:id`, layout routes with an empty path add nothing, and your wildcard route is `/**`. A route matched by a `matcher` function has no `path` either, so it adds nothing to the name.
- **Redirects from guards and resolvers stay in one span.** A guard that returns a `UrlTree`, or a resolver that returns a `RedirectCommand`, cancels the navigation with the code `Redirect` and immediately starts a new one. Both are one span, named after the route the user lands on: a click on `/old` that a guard sends to `/projects/1` is one `navigate /projects/:id` span with `url.path` set to `/old`. A redirect to the URL already on screen ends the span, named after that route. A `redirectTo` in the route config doesn't cancel anything; it's resolved while matching. With SSR, a full page load of a redirecting URL is an HTTP 302 from the server, and the `pageload` span joins the render of the page it lands on.
- **Late events never end a newer span.** Every event carries its navigation's `id`, and only the latest navigation ends the span.
- **A second click interrupts the first navigation.** When the user clicks a link before the previous navigation finished loading, Angular cancels the old one with the code `SupersededByNewNavigation`, and its span ends with `app.navigation.interrupted` set. That includes a click on a link to the URL on screen. The old span keeps the bare name `navigate`, since its route never activated, and its resolver span can outlive it: Angular doesn't stop a running resolver, it ignores the result.
- **Query-only changes, fragments and back/forward are full navigations.** Going from `/projects/42` to `/projects/42?tab=members`, following a `routerLink` with a `fragment`, or pressing the back button each gets its own `navigate` span named after the route. By default, resolvers only rerun when path or matrix params change, so a query-only change is a short span with nothing under it.
- **Navigating to the URL you're already on starts no span.** Angular emits `NavigationSkipped` without a `NavigationStart`.
- **Failed navigations aren't marked as errors.** A navigation that ends in `NavigationError` is named after the route it tried to reach, but its span isn't marked `Error`. The error itself is on the resolver's span, or on an `angular.error` span from the `ErrorHandler`.
- **`url.path` is the router's URL.** It leaves out your `<base href>` and keeps matrix params like `;tab=members`.

## Trace Angular route resolvers

Resolvers are Angular's data loading step: the router waits for them before it activates the route, so their time is navigation time. `tracedResolver` runs a resolver's data loading in a span under the current navigation:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient } from "@angular/common/http"
import { inject } from "@angular/core"
import type { ResolveFn } from "@angular/router"
import { tracedResolver } from "@maple-dev/browser/angular"
import { firstValueFrom } from "rxjs"
import type { Member, Project } from "./project"

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

`tracedResolver` works with promises, so `firstValueFrom` turns each `HttpClient` observable into one. This also nests correctly: `firstValueFrom` subscribes right away, and Angular's fetch backend calls `fetch()` synchronously during that subscribe, while the resolver span is still active. Sequential `await`s are a different story. Only requests started before the first `await` nest under the span; see [the await problem](#the-await-problem).

It's `MapleBrowser.traced` with one addition, for redirects. A resolver usually redirects by returning a `RedirectCommand`, which is a normal result. The router also accepts a thrown one, handy from inside a helper function, and `tracedResolver` doesn't mark the span as failed for it either.

A missing record is a redirect too. Catch the 404 inside the function you pass to `tracedResolver` and return a `RedirectCommand` to your not-found route:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient, HttpErrorResponse } from "@angular/common/http"
import { inject } from "@angular/core"
import { RedirectCommand, type ResolveFn, Router } from "@angular/router"
import { tracedResolver } from "@maple-dev/browser/angular"
import { firstValueFrom } from "rxjs"
import type { Member, Project } from "./project"

export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	const http = inject(HttpClient)
	const router = inject(Router)
	const id = route.paramMap.get("id")

	return tracedResolver("loader /projects/:id", async () => {
		try {
			return await Promise.all([
				firstValueFrom(http.get<Project>(`/api/projects/${id}`)),
				firstValueFrom(http.get<Member[]>(`/api/projects/${id}/members`)),
			])
		} catch (error) {
			if (error instanceof HttpErrorResponse && error.status === 404) {
				return new RedirectCommand(router.parseUrl("/not-found"), { skipLocationChange: true })
			}
			throw error
		}
	})
}
```

The loader span stays Ok and the navigation span is named after the not-found route, `navigate /not-found`, with the requested path in `url.path`. The `fetch` span for the 404 is still marked `Error`, as OpenTelemetry marks every 4xx client span, but Maple doesn't open an issue for it. A URL no route matches lands on your `**` route: `navigate /**`.

One thing the waterfall will show you: the router runs the resolvers of nested routes one level at a time. A parent route's resolvers finish before its child's start, and only the resolvers within one route run in parallel. If a layout resolver and a page resolver don't depend on each other, that's a waterfall you can remove by moving both into one route's `resolve` map.

## Report errors caught by Angular's ErrorHandler

Angular catches errors thrown in templates, lifecycle hooks, and template event listeners, and hands them to the `ErrorHandler` service. That's why a broken `(click)` handler logs `ERROR` in the console instead of reaching `window.onerror`, where the SDK would see it. `RouterLink` does the same with a failed navigation.

`MapleErrorHandler`, which the app config above provides, reports each of those errors as an `angular.error` span, then logs it to the console like Angular's own handler:

- **A `(click)` handler that throws is reported once**, as an `angular.error` span. It never becomes a `browser.uncaught_error`, since the error doesn't reach `window.onerror`.
- **A failed resolver is one error.** A resolver that throws fails the navigation, and `RouterLink` passes the same error object to the `ErrorHandler`. `tracedResolver` already recorded it on the resolver's span, so `MapleErrorHandler` skips it.
- **Global errors are reported once.** `provideBrowserGlobalErrorListeners()`, which new CLI projects include, sends uncaught errors and unhandled rejections to the `ErrorHandler` too. Those also reach the SDK's own global handlers, but you still get one issue per error: `captureException` records each error object once, whichever handler sees it first. An `error` event without an error object, like a cross-origin `Script error.`, reaches the `ErrorHandler` wrapped in a new `Error`, which `MapleErrorHandler` skips, since the SDK's own handler already recorded the event.

`provideMapleTracing()` leaves the `ErrorHandler` to you on purpose. An app has one `ErrorHandler`, and the last provider for it wins, so one hidden inside `provideMapleTracing()` would replace a handler your app already provides, or be replaced by it, depending on the order of the providers. If your app has its own, keep it and call `reportAngularError` from it instead of providing `MapleErrorHandler`:

```ts
// src/app/error-handler.ts
import { ErrorHandler, Injectable } from "@angular/core"
import { reportAngularError } from "@maple-dev/browser/angular"

@Injectable()
export class AppErrorHandler extends ErrorHandler {
	override handleError(error: unknown) {
		reportAngularError(error)
		// ...your own handling
		super.handleError(error)
	}
}
```

`reportAngularError` skips the same errors `MapleErrorHandler` does. Two cases to watch for:

- **`withNavigationErrorHandler` can hide errors.** If your handler returns a `RedirectCommand` to show an error page, the navigation becomes a redirect and the error never reaches `ErrorHandler`. Errors from `tracedResolver` are still on their span; report anything else with `reportAngularError(event.error)` inside that handler.
- **`onViewError` replaces `handleError` for `@boundary` blocks.** Angular 22's `ErrorHandler` has an optional `onViewError` method. If you implement it, Angular calls it instead of `handleError` for errors caught by a `@boundary` block, so call `reportAngularError(error)` there too. `MapleErrorHandler` doesn't implement it, so those errors land in `handleError`.

## Trace server rendering with @angular/ssr

With `@angular/ssr`, the first page load starts on your Node server. Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), in a plain JavaScript file like `telemetry.mjs` at the project root, preloaded with `node --import ./telemetry.mjs dist/acme-web/server/server.mjs` so it runs before the server bundle. Keep that guide's `register()` call for OpenTelemetry's ES module hook, since the server build is an ES module. That gives you a span for every incoming request.

The Angular CLI bundles Express into `server.mjs`, so the Express instrumentation has nothing to patch. The HTTP instrumentation still creates a server span per request (named after the method, like `GET`), and the undici instrumentation traces the `HttpClient` requests your resolvers make during the render. Those two are the instrumentations that matter here.

Then wrap the render in the middleware at the bottom of the generated `src/server.ts` with `tracedRender`. It runs the render in a span and hands its trace to the browser in a `Server-Timing` header:

```ts
// src/server.ts
import { AngularNodeAppEngine, writeResponseToNodeResponse } from "@angular/ssr/node"
import { tracedRender } from "@maple-dev/browser/angular/server"
import express from "express"

const app = express()
const angularApp = new AngularNodeAppEngine()

// ...express.static() and your API routes, as generated

app.use((req, res, next) => {
	tracedRender(req, () => angularApp.handle(req))
		.then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
		.catch(next)
})
```

On the browser side there's nothing to add. The `pageload` span reads the header and becomes a child of the render's span, so the first load is one trace from the incoming request to the first `NavigationEnd` in the browser.

A few things to know about the `ssr` span:

- **It sits under the request span.** The HTTP instrumentation's `GET` span is its parent, and the browser's `pageload` span is its child.
- **It has a fixed name.** Express doesn't know which Angular route matched, so `url.path` carries the path, and the browser's `pageload /projects/:id` span in the same trace carries the template.
- **It ends when `handle()` resolves**, once the app is stable: after the server-side navigation, its resolvers, and pending `HttpClient` requests. Writing the HTML out happens after it, inside the request span.
- **Render errors are recorded.** If `handle()` throws, the `ssr` span records the error and is marked `Error`, and the error goes on to Express through `next`.
- **Resolvers nest under it on the server.** `tracedResolver` works there too, and Node's `AsyncLocalStorage` keeps the request's context across `await`s, so server-side resolver spans need no changes.
- **`ErrorHandler` runs on the server too.** `MapleErrorHandler` is part of the app config, and it records into the server's trace during the render. A component that throws while rendering is reported twice on a full page load: once in the `ssr` trace and once when the browser hydrates.
- **A resolver that throws during the render gets no page.** `handle()` resolves `null`, Express answers with its own 404, and the browser never starts Angular, so there's no `pageload` span. The error is on the server's resolver span, under an `ssr` span: `tracedRender` opens one for every request that reaches it, including the ones Angular doesn't render.
- **The browser's first resolvers look suspiciously fast.** `provideClientHydration()` replays the `HttpClient` GET requests made during the server render (except ones with auth headers or credentials), so the browser's first resolver spans have no fetch spans under them. The real requests are in the same trace, under the `ssr` span.

If a CDN caches your HTML, render those pages with `angularApp.handle(req)` directly, without `tracedRender`, or every visitor's page load will join the same old trace. `@angular/ssr` sets no `ETag` on rendered pages, so a reload always gets a fresh render and a new trace.

## Angular-specific gotchas

- **`ZoneContextManager` doesn't help here.** It's OpenTelemetry's answer to losing context after `await`, and it needs zone.js. New Angular apps are zoneless by default. And even with zone.js, Angular's fetch backend calls `fetch()` inside `NgZone.runOutsideAngular`, which leaves the zone that holds the active span. The context is gone by the time the request starts.
- **With zone.js, resolvers delay stability.** `provideMapleTracing()` handles router events outside Angular's zone, but a resolver's span ends inside it, and ending a span starts the exporter's 2-second timer as a zone task. After a navigation with resolvers, `ApplicationRef.isStable` stays `false` until the next export, which delays anything that waits for it, like the service worker's default registration. Zoneless apps aren't affected.
- **Data loaded in components starts its own traces.** `httpResource` and requests in `ngOnInit` run after the component is created, which is after `NavigationEnd`. They're fetch spans without a parent. If they're part of what the user waits for, a resolver puts them in the navigation.
- **Lazy routes show up as gaps.** Loading a `loadComponent` or `loadChildren` chunk happens inside the navigation span, but dynamic `import()` isn't a `fetch`, so there's no child span. A gap at the start of a navigation with nothing under it is often a chunk download.
- **`HttpErrorResponse` isn't an `Error`.** When a resolver's request fails, the resolver span records its message, and the fetch span under it has the status code and URL.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does Angular have built-in OpenTelemetry support?

No, Angular 22 doesn't ship an OpenTelemetry integration. `@maple-dev/browser/angular` uses public APIs only: `Router.events`, resolvers and `ErrorHandler` in the browser, and `AngularNodeAppEngine` on the server. It's plain functions and a class without decorators, so it needs no Angular compiler step.

### Why don't my Angular HttpClient requests show up as spans?

On Angular 21 and older, `HttpClient` uses `XMLHttpRequest` unless you add `withFetch()`, and the browser SDK only instruments `fetch`. On Angular 22, check for `withXhr()`. If the requests show up but aren't connected to your backend, check the [cross-origin setup](#connect-browser-traces-to-your-backend).

### Does this work with NgModule-based Angular apps?

Yes. Add `provideMapleTracing()` and the `ErrorHandler` provider to your root module's `providers`, which accept the same providers, and import `./maple` before calling `bootstrapModule`.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

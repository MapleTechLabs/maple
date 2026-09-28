---
title: "Frontend tracing for Angular"
description: "Trace every Angular Router navigation, resolver and HttpClient request as one OpenTelemetry trace, linked to your backend, your server render and session replay."
group: "Frontend"
order: 6
navLabel: "Angular"
icon: "angular"
---

Angular's router reports every step of a navigation on one observable, `Router.events`, so you can see when a navigation starts, redirects, fails or finishes without patching anything. This guide turns a click on a `routerLink` into one trace with a span for the navigation, a span per resolver, the `HttpClient` requests those resolvers made, and the backend spans behind them. With `@angular/ssr`, the first page load also includes the server render. The code was checked against Angular 22 with standalone APIs.

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
npm install @maple-dev/browser @opentelemetry/api
```

`@opentelemetry/api` is for the tracing helper below. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

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

### Make sure HttpClient uses fetch

Start here, because it decides whether you see any network spans at all. The browser SDK instruments `fetch`, not `XMLHttpRequest`, and `HttpClient` can use either.

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

`init()` sets up:

- a span for every `fetch()` call;
- error spans for uncaught errors and unhandled promise rejections, which show up on the [Errors](/docs/errors/overview) page;
- session replay, with the same `session.id` on every span and replay event, so a trace links to the recording of the session that produced it;
- export every 2 seconds, plus a flush when the tab is hidden or closed, so the spans from the last moments of a visit aren't lost;
- redaction of credential-looking query parameters (`token`, `code`, `password` and similar) in every URL it sends.

Use the public ingest key (`maple_pk_…`) from **Settings → Ingestion**. It can only write telemetry, so it's safe in browser code. For an EU organization, add `region: "eu"`. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

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

## Add the tracing helper

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to the Angular Router:

```ts
// src/tracing.ts
import { context, propagation, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("acme-web")

let navigation: { span: Span; kind: "pageload" | "navigate" } | undefined
let firstLoad = true

/** Call when the router starts a navigation. */
export function startNavigation(path: string) {
	// A click before the last navigation finished replaces it
	navigation?.span.setAttribute("app.navigation.interrupted", true)
	navigation?.span.end()

	const kind = firstLoad ? "pageload" : "navigate"
	// Only the first page load belongs to the server's trace, if there was one
	const parent = firstLoad ? serverContext() : context.active()
	firstLoad = false

	navigation = { kind, span: tracer.startSpan(kind, { attributes: { "url.path": path } }, parent) }
}

/** Call when the new route is ready. `route` is its template, like `/projects/:id`. */
export function endNavigation(route?: string) {
	if (!navigation) return
	if (route) navigation.span.updateName(`${navigation.kind} ${route}`)
	navigation.span.end()
	navigation = undefined
}

const recorded = new WeakSet<object>()

/** Run `fn` in a span under the current navigation. */
export function traced<T>(
	name: string,
	fn: () => Promise<T>,
	isFailure: (error: unknown) => boolean = () => true,
): Promise<T> {
	const parent = navigation ? trace.setSpan(context.active(), navigation.span) : context.active()

	return tracer.startActiveSpan(name, {}, parent, async (span) => {
		try {
			return await fn()
		} catch (error) {
			if (isFailure(error)) {
				// Some libraries throw error-like objects that aren't Error instances
				span.recordException(error instanceof Error ? error : String((error as { message?: unknown })?.message ?? error))
				span.setStatus({ code: SpanStatusCode.ERROR })
				if (typeof error === "object" && error !== null) recorded.add(error)
			}
			throw error
		} finally {
			span.end()
		}
	})
}

/** Whether `traced` already recorded this error on a span. */
export const alreadyRecorded = (error: unknown) =>
	typeof error === "object" && error !== null && recorded.has(error)

/** The trace the server rendered this page under, from a `Server-Timing` header or a `<meta>` tag. */
function serverContext() {
	if (typeof document === "undefined") return context.active()
	const [page] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
	const traceparent =
		page?.serverTiming?.find((entry) => entry.name === "traceparent")?.description ||
		document.querySelector<HTMLMetaElement>('meta[name="traceparent"]')?.content
	return traceparent ? propagation.extract(context.active(), { traceparent }) : context.active()
}
```

- `startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `endNavigation(route)` names the span after the route template and ends it.
- `traced(name, fn, isFailure)` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`.
- `alreadyRecorded(error)` tells you whether `traced` already recorded an error, so it isn't reported twice.
- `serverContext()` joins the first page load to the server's trace when the server sent its trace context, in a `Server-Timing` header or a `<meta name="traceparent">` tag. In a client-only app it does nothing.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

### The await problem

Browsers have no equivalent of Node's `AsyncLocalStorage`, so OpenTelemetry's web context manager only tracks the active span synchronously. Inside `traced`, a `fetch()` called before the first `await` nests under the span. A `fetch()` called after it starts a new trace:

```ts
// Both requests nest under the span
traced("load project", () => Promise.all([fetchProject(id), fetchMembers(id)]))

// The second request loses its parent
traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id) // new trace
	return { project, members }
})
```

When a request depends on an earlier one, capture the context before the first `await` with `const ctx = context.active()`, and make the request with `context.with(ctx, () => fetchMembers(project.id))`. Sequential awaits while loading a page are also a request waterfall, so check whether the requests can run in parallel first.

## Trace Angular Router navigations

Every navigation emits a `NavigationStart`. When it's over, it emits `NavigationEnd` if the new route's components were created, `NavigationCancel` if a guard said no, something redirected, or a newer navigation replaced it, and `NavigationError` if something threw. Subscribe to them in an app initializer, which runs before the router starts the first navigation:

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
		// The server render gets its own span, see below
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

			// A same-URL navigation has no NavigationStart, but it still supersedes a pending one
			if (event instanceof NavigationSkipped) {
				endNavigation()
				return
			}

			const ended =
				event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError
			// Only the latest navigation owns the span
			if (!ended || event.id !== current) return

			if (event instanceof NavigationCancel) {
				if (event.code === NavigationCancellationCode.Redirect) redirecting = true
				// Otherwise the next NavigationStart ends it as interrupted
				else if (event.code !== NavigationCancellationCode.SupersededByNewNavigation) endNavigation()
			} else if (event instanceof NavigationEnd) {
				endNavigation(routeTemplate(router.routerState.snapshot.root))
			} else if (event.target) {
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

Register it next to the router:

```ts
// src/app/app.config.ts
import { provideHttpClient } from "@angular/common/http"
import { type ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from "@angular/core"
import { provideRouter } from "@angular/router"
import { routes } from "./app.routes"
import { MapleErrorHandler } from "./error-handler"
import { provideRouterTracing } from "./router-tracing"

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideRouter(routes),
		provideHttpClient(),
		provideRouterTracing(),
		{ provide: ErrorHandler, useClass: MapleErrorHandler },
	],
}
```

`MapleErrorHandler` comes up in the errors section below.

Some details that are easy to get wrong:

- **Build the span name from `routeConfig.path`, not from the URL.** Angular has no single "full path" property, so `routeTemplate` walks the activated routes from the root and joins their configured paths. Nested routes like `{ path: "projects", children: [{ path: ":id" }] }` come out as `/projects/:id`, and your not-found route is `/**`.
- **Redirects from guards and resolvers are two navigations.** A guard that returns a `UrlTree`, or a resolver that returns a `RedirectCommand`, cancels the navigation with the code `Redirect` and immediately starts a new one. The `redirecting` flag keeps both in one span, named after the route the user lands on: a click on `/old` that a guard sends to `/projects/1` is one `navigate /projects/:id` span with `url.path` set to `/old`. A `redirectTo` in the route config doesn't cancel anything; it's resolved while matching. With SSR, a full page load of a redirecting URL is an HTTP 302 from the server, and the `pageload` span joins the render of the page it lands on.
- **Every event carries the navigation's `id`.** The id check makes sure a late event from an old navigation never ends the new span.
- **A second click interrupts the first navigation.** When the user clicks a link before the previous navigation finished loading, Angular cancels the old one with the code `SupersededByNewNavigation` just before the new `NavigationStart`. The handler leaves that span open, so `startNavigation` ends it with `app.navigation.interrupted` set. The old span keeps the bare name `navigate`, since its route never activated, and its resolver span can outlive it: Angular doesn't stop a running resolver, it ignores the result.
- **Query-only changes, fragments and back/forward are full navigations.** Going from `/projects/42` to `/projects/42?tab=members`, following a `routerLink` with a `fragment`, or pressing the back button each gets its own `navigate` span named after the route. By default, resolvers only rerun when path or matrix params change, so a query-only change is a short span with nothing under it.
- **Navigating to the URL you're already on emits `NavigationSkipped`** without a `NavigationStart`, so it creates no span. It still replaces a navigation that was pending, which is why the handler ends the open span on `NavigationSkipped`.
- **The platform check matters with SSR.** App initializers also run during the server render, where the helper's module-level navigation state would be shared between requests.

## Trace Angular route resolvers

Resolvers are Angular's data loading step: the router waits for them before it activates the route, so their time is navigation time. `resolverSpan` from the previous section wraps one in a span under the current navigation:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient } from "@angular/common/http"
import { inject } from "@angular/core"
import type { ResolveFn } from "@angular/router"
import { firstValueFrom } from "rxjs"
import { resolverSpan } from "../router-tracing"
import type { Member, Project } from "./project"

export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	// inject() only works synchronously, before the first await
	const http = inject(HttpClient)
	const id = route.paramMap.get("id")

	return resolverSpan("loader /projects/:id", () =>
		Promise.all([
			firstValueFrom(http.get<Project>(`/api/projects/${id}`)),
			firstValueFrom(http.get<Member[]>(`/api/projects/${id}/members`)),
		]),
	)
}
```

The helper works with promises, so `firstValueFrom` turns each `HttpClient` observable into one. This also nests correctly: `firstValueFrom` subscribes right away, and Angular's fetch backend calls `fetch()` synchronously during that subscribe, while the resolver span is still active. Sequential `await`s are a different story. Only requests started before the first `await` nest under the span; see [the await problem](#the-await-problem).

The `isFailure` check in `resolverSpan` is for redirects. A resolver usually redirects by returning a `RedirectCommand`, which `traced` treats as a normal result. The router also accepts a thrown one, handy from inside a helper function, so a thrown `RedirectCommand` doesn't mark the span as failed either.

A missing record is a redirect too. Catch the 404 inside the function you pass to `resolverSpan` and return a `RedirectCommand` to your not-found route:

```ts
// src/app/projects/project.resolver.ts
import { HttpClient, HttpErrorResponse } from "@angular/common/http"
import { inject } from "@angular/core"
import { RedirectCommand, type ResolveFn, Router } from "@angular/router"
import { firstValueFrom } from "rxjs"
import { resolverSpan } from "../router-tracing"
import type { Member, Project } from "./project"

export const projectResolver: ResolveFn<[Project, Member[]]> = (route) => {
	const http = inject(HttpClient)
	const router = inject(Router)
	const id = route.paramMap.get("id")

	return resolverSpan("loader /projects/:id", async () => {
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

Replace the default handler with one that reports first:

```ts
// src/app/error-handler.ts
import { ErrorHandler, Injectable } from "@angular/core"
import { MapleBrowser } from "@maple-dev/browser"
import { alreadyRecorded } from "../tracing"

@Injectable()
export class MapleErrorHandler extends ErrorHandler {
	override handleError(error: unknown) {
		// Resolver errors are already on their resolver span
		if (!alreadyRecorded(error)) MapleBrowser.captureException(error, { name: "angular.error" })
		// Keep Angular's console output
		super.handleError(error)
	}
}
```

The app config above already provides it. A `(click)` handler that throws is reported once, as an `angular.error` span; it never becomes a `browser.uncaught_error`, since the error doesn't reach `window.onerror`. The `alreadyRecorded` check is for resolvers: a resolver that throws fails the navigation, and `RouterLink` passes the same error object to this handler. Without the check, one failed resolver would show up as two errors.

`provideBrowserGlobalErrorListeners()`, which new CLI projects include, sends uncaught errors and unhandled rejections to the `ErrorHandler` too. Those also reach the SDK's own global handlers, but you still get one issue per error: `captureException` records each error object once, whichever handler sees it first.

Two cases to watch for:

- **`withNavigationErrorHandler` can hide errors.** If your handler returns a `RedirectCommand` to show an error page, the navigation becomes a redirect and the error never reaches `ErrorHandler`. Errors from `resolverSpan` are still on their span; report anything else from inside that handler.
- **`onViewError` replaces `handleError` for `@boundary` blocks.** Angular 22's `ErrorHandler` has an optional `onViewError` method. If you implement it, Angular calls it instead of `handleError` for errors caught by a `@boundary` block, so report from there too. The handler above doesn't implement it, so those errors land in `handleError`.

## Trace server rendering with @angular/ssr

With `@angular/ssr`, the first page load starts on your Node server. Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), in a plain JavaScript file like `telemetry.mjs` at the project root, preloaded with `node --import ./telemetry.mjs dist/acme-web/server/server.mjs` so it runs before the server bundle. That gives you a span for every incoming request.

The Angular CLI bundles Express into `server.mjs`, so the Express instrumentation has nothing to patch. The HTTP instrumentation still creates a server span per request (named after the method, like `GET`), and the undici instrumentation traces the `HttpClient` requests your resolvers make during the render. Those two are the instrumentations that matter here.

Then replace the render middleware at the bottom of the generated `src/server.ts` with one that wraps the render in a span and hands its trace to the browser in a `Server-Timing` header:

```ts
// src/server.ts
import { AngularNodeAppEngine, writeResponseToNodeResponse } from "@angular/ssr/node"
import { context, propagation, trace } from "@opentelemetry/api"
import express from "express"

const tracer = trace.getTracer("acme-web")
const app = express()
const angularApp = new AngularNodeAppEngine()

// ...express.static() and your API routes, as generated

app.use((req, res, next) => {
	tracer.startActiveSpan("ssr", { attributes: { "url.path": req.path } }, async (span) => {
		try {
			const response = await angularApp.handle(req)
			if (!response) return next()

			// Hand this trace to the browser so its pageload span can join it
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

On the browser side there's nothing to add. `startNavigation` reads the header through `serverContext()` and parents the `pageload` span to the server render, so the first load is one trace from the incoming request to the first `NavigationEnd` in the browser.

A few things to know about the `ssr` span:

- **It has a fixed name.** Express doesn't know which Angular route matched, so `url.path` carries the path, and the browser's `pageload /projects/:id` span in the same trace carries the template.
- **`handle()` resolves once the app is stable**, after the server-side navigation, its resolvers, and pending `HttpClient` requests. The span also covers writing the HTML out, since it ends after `writeResponseToNodeResponse`.
- **Resolvers nest under it on the server.** `resolverSpan` works there too, and Node's `AsyncLocalStorage` keeps the request's context across `await`s, so server-side resolver spans need no changes.
- **`ErrorHandler` runs on the server too.** `MapleErrorHandler` is part of the app config, and `captureException` records into the server's trace during the render. A component that throws while rendering is reported twice on a full page load: once in the `ssr` trace and once when the browser hydrates.
- **A resolver that throws during the render gets no page.** `handle()` resolves `null`, Express answers with its own 404, and the browser never starts Angular, so there's no `pageload` span. The error is on the server's resolver span.
- **The browser's first resolvers look suspiciously fast.** `provideClientHydration()` replays the `HttpClient` GET requests made during the server render (except ones with auth headers or credentials), so the browser's first resolver spans have no fetch spans under them. The real requests are in the same trace, under the `ssr` span.

If a CDN caches your HTML, skip the `server-timing` header on those responses, or every visitor's page load will join the same old trace. `@angular/ssr` sets no `ETag` on rendered pages, so a reload always gets a fresh render and a new trace.

## Angular-specific gotchas

- **`ZoneContextManager` doesn't help here.** It's OpenTelemetry's answer to losing context after `await`, and it needs zone.js. New Angular apps are zoneless by default. And even with zone.js, Angular's fetch backend calls `fetch()` inside `NgZone.runOutsideAngular`, which leaves the zone that holds the active span. The context is gone by the time the request starts.
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

No, Angular 22 doesn't ship an OpenTelemetry integration. Everything in this guide uses public APIs: `Router.events`, resolvers, `ErrorHandler`, and `AngularNodeAppEngine`.

### Why don't my Angular HttpClient requests show up as spans?

On Angular 21 and older, `HttpClient` uses `XMLHttpRequest` unless you add `withFetch()`, and the browser SDK only instruments `fetch`. On Angular 22, check for `withXhr()`. If the requests show up but aren't connected to your backend, check the [cross-origin setup](#connect-browser-traces-to-your-backend).

### Does this work with NgModule-based Angular apps?

Yes. Add `provideRouterTracing()` and the `ErrorHandler` provider to your root module's `providers`, which accept the same providers, and import `./maple` before calling `bootstrapModule`.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

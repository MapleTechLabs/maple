---
title: "Frontend tracing for Vue, Vue Router and Nuxt"
description: "Trace every Vue Router navigation, the data your pages load and the errors Vue catches as one OpenTelemetry trace, plus the server render in Nuxt."
group: "Frontend"
order: 4
navLabel: "Vue & Nuxt"
icon: "vue"
---

Vue Router tells you exactly when a navigation starts and when it's confirmed. Most Vue apps load their data after that point, inside the new page's `setup`, and that's the one thing to design around when tracing a Vue app. This guide turns a click into one trace with a span for the navigation, a span for each piece of data the new page loads, and the fetches and backend spans behind them. In Nuxt, the first page load also includes the server render. The code is for Vue 3.5 and works the same with Vue Router 4 and 5.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Vue with Vue Router (or Nuxt).

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser @opentelemetry/api
```

`@opentelemetry/api` is for the tracing helper below. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	environment: import.meta.env.MODE,
})
```

Import `./maple` first in `src/main.ts`, before `createApp`. Nuxt has no `main.ts`; see [Nuxt](#tracing-nuxt-client-plugin-vueerror-and-the-server-timing-header) below.

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

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to Vue Router:

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

In the browser, a span only stays active until the first `await` inside it. A request that starts after an `await` loses its parent and shows up as a separate trace.

```ts
// ❌ fetchMembers starts after an await, so it becomes its own trace
traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id)
	return { project, members }
})
```

```ts
// ✅ Save the context before the first await, and run later requests inside it
import { context } from "@opentelemetry/api"

traced("load project", async () => {
	const ctx = context.active()
	const project = await fetchProject(id)
	const members = await context.with(ctx, () => fetchMembers(project.id))
	return { project, members }
})
```

If the requests don't depend on each other, start them together with `Promise.all` instead. Both nest under the span, and the page stops waiting on one request before starting the next.

This happens because browsers have no equivalent of Node's `AsyncLocalStorage`, which is what carries the active span across `await` on the server.

## Trace Vue Router navigations with beforeEach and afterEach

Three router hooks cover the life of a navigation:

- `router.beforeEach` runs when a navigation starts, before lazy-loaded route components are fetched.
- `router.afterEach` runs when it's over, with a `failure` argument if it didn't complete.
- `router.onError` runs instead of `afterEach` when a guard throws or a route component fails to load.

```ts
// src/router-tracing.ts
import { MapleBrowser } from "@maple-dev/browser"
import { nextTick } from "vue"
import { isNavigationFailure, NavigationFailureType, type Router } from "vue-router"
import { alreadyRecorded, endNavigation, startNavigation } from "./tracing"

export function traceRouter(router: Router) {
	// The location that started the navigation in progress
	let current: object | undefined

	router.beforeEach((to) => {
		// A redirect runs the guards again for its target. Keep it in the open span
		const origin = to.redirectedFrom ?? to
		if (origin === current) return
		current = origin
		startNavigation(to.path)
	})

	router.afterEach((to, _from, failure) => {
		// Cancelled: a newer navigation already replaced this one. Duplicated: nothing happened
		if (isNavigationFailure(failure, NavigationFailureType.cancelled | NavigationFailureType.duplicated)) return

		const navigation = current
		// Wait for Vue to render the new route, so fetches started in setup nest under the span
		nextTick(() => {
			if (current === navigation) endNavigation(to.matched.at(-1)?.path)
		})
	})

	// Errors thrown in guards and failed route chunk loads end up here, and afterEach never runs
	router.onError((error, to) => {
		endNavigation(to.matched.at(-1)?.path)
		if (!alreadyRecorded(error)) MapleBrowser.captureException(error, { name: "vue_router.error" })
	})
}
```

Call it right after creating the router. Guards run in the order they were added, so adding these first puts your own guards inside the span:

```ts
// src/router/index.ts
import { createRouter, createWebHistory } from "vue-router"
import { traceRouter } from "../router-tracing"
import { routes } from "./routes"

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })

// Before any other guard, so the navigation span covers them too
traceRouter(router)

export default router
```

The first navigation starts when `app.use(router)` installs the router, and `startNavigation` turns it into the `pageload` span without any check for `START_LOCATION`. That span starts when your bundle runs, so it doesn't include downloading the HTML and JavaScript.

Why `nextTick`? `afterEach` runs as soon as the navigation is confirmed, before Vue has rendered the new route. `nextTick` resolves after that render, when the new page's `setup`, its immediate watchers, and its `onMounted` hooks have run, so anything they start lands inside the span. The `current === navigation` check skips the end if another navigation started in the meantime.

### Route templates, redirects, and failed navigations

- **The span name comes from `to.matched.at(-1)?.path`.** That's the deepest matched route's full path, parents included, with params as placeholders: `/projects/:id`, not `/projects/8f2a`.
- **Redirects stay in one span.** When a guard returns a different location, Vue Router runs the guards again for the new target and sets `to.redirectedFrom`. `beforeEach` sees the same origin and keeps the open span, so a redirect to the login page is one `navigate /login` span with the original path in `url.path`. The same check covers a `redirect` declared on a route record, which skips the guards for the original location.
- **Aborted navigations end normally.** A guard that returns `false` ends the span, named after the route the user tried to reach.
- **Cancelled and duplicated navigations are skipped.** A cancelled navigation was replaced by a newer one, and `startNavigation` already ended its span as interrupted. A duplicated one was a click on a link to the current page, which runs no guards.
- **Interrupted navigations keep a plain name.** A navigation that is still loading its route chunk or waiting on a guard when the next click comes in ends as `navigate`, with no template, because its route never resolved. Most Vue navigations resolve at once, though, and it's the page's data loading that outlives them. That load span keeps running in the old trace, which is what happened.
- **Query and hash changes are navigations.** A search page that syncs its filters to the URL gets a span per change, and so does a plain `<a href="#section">` link, because the router sees the browser's `popstate`. If that's noise, return early in `beforeEach` when `from !== START_LOCATION && to.path === from.path`. The first check matters, because `START_LOCATION.path` is `/`.
- **Back and forward are navigations too.** They run the same guards, so each step is a `navigate` span, and the page loads its data again unless it's in `<KeepAlive>`.

## Trace data loading in Vue components

Vue Router doesn't load data for you. Most Vue apps fetch in the page component, in `setup`, `onMounted` or a watcher on the route params, and that code runs before the navigation span ends. Wrap it in `traced`, and name the span `loader` plus the route template, like the other framework guides:

```vue
<!-- src/pages/ProjectPage.vue -->
<script setup lang="ts">
import { ref, watch } from "vue"
import { useRoute } from "vue-router"
import { type Project, fetchProject } from "../api"
import { traced } from "../tracing"

const route = useRoute()
const project = ref<Project>()

watch(
	() => route.params.id as string,
	async (id) => {
		project.value = await traced("loader /projects/:id", () => fetchProject(id))
	},
	{ immediate: true },
)
</script>

<template>
	<h1>{{ project?.name }}</h1>
</template>
```

`immediate: true` runs the watcher during `setup`, so the first load nests under the navigation. Going from `/projects/1` to `/projects/2` reuses the component, and the watcher fires again while that navigation renders.

The load span usually ends after its parent: the navigation span stops when the new page rendered, the load span when the data arrived. That's what the user saw, a page and then its content. As always, only requests started before the first `await` nest under the span (see [the await problem](#the-await-problem)).

If you'd rather have the navigation wait for the data, fetch in a `beforeResolve` guard or the page's `beforeRouteEnter`. Those run inside the navigation, and `traced` works there unchanged. Vue Router 5 also has data loaders that do this (`defineBasicLoader` in `vue-router/experimental`), but they're experimental, and their `reroute()` redirects by throwing, which `traced` would record as a failure.

### Aborted requests aren't failures

Vue Router guards redirect by returning a location, not by throwing, so the default `isFailure` is right for router code. Where the third argument does matter is aborted requests. If the id changes again before the first request finished, you usually want to cancel it:

```ts
// The watcher from above, with `onWatcherCleanup` imported from "vue"
watch(
	() => route.params.id as string,
	async (id) => {
		const controller = new AbortController()
		// Runs when the id changes again, or the page unmounts, before this request finished
		onWatcherCleanup(() => controller.abort())

		const aborted = () => controller.signal.aborted
		try {
			project.value = await traced("loader /projects/:id", () => fetchProject(id, controller.signal), () => !aborted())
		} catch (error) {
			if (!aborted()) throw error
		}
	},
	{ immediate: true },
)
```

The aborted fetch rejects with an `AbortError`. The third argument keeps it from marking the span as failed, and the `catch` keeps it away from Vue's error handler.

### Not-found pages

Vue Router has no not-found error either. A common pattern is to load the data, and on a 404 replace the route with the catch-all route while keeping the URL. Throw your own error class for the 404, and use the third argument to keep it from counting as a failure:

```ts
// Thrown by your API client on a 404
class NotFoundError extends Error {}

try {
	project.value = await traced("loader /projects/:id", () => fetchProject(id), (error) => !(error instanceof NotFoundError))
} catch (error) {
	if (!(error instanceof NotFoundError)) throw error
	await router.replace({
		name: "not-found",
		params: { pathMatch: route.path.substring(1).split("/") },
		query: route.query,
		hash: route.hash,
	})
}
```

The replace is a second navigation, so it gets its own trace, named after the catch-all route: `navigate /:pathMatch(.*)*`. The `fetch` span that got the 404 is still marked as an error, like every client request with a 4xx status.

## Report errors with app.config.errorHandler

Vue catches errors thrown in components, watchers, lifecycle hooks, and event handlers, and passes them to `app.config.errorHandler`. Without one, development builds rethrow the error, so the SDK's global handlers see it.

Production builds only log it with `console.error`. That's how you end up with error reporting that works on your machine and reports nothing in production. Set the handler:

```ts
// src/main.ts
import "./maple" // first, before anything renders
import { MapleBrowser } from "@maple-dev/browser"
import { createApp } from "vue"
import App from "./App.vue"
import router from "./router"
import { alreadyRecorded } from "./tracing"

const app = createApp(App)

app.config.errorHandler = (error, _instance, info) => {
	// Setting a handler turns off Vue's own logging, so keep it
	console.error(error)
	// Errors thrown inside traced() are already on their span
	if (!alreadyRecorded(error)) {
		MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	}
}

app.use(router)
app.mount("#app")
```

- A failed `load project` records the error on its span and rethrows, and Vue passes the rejected watcher to `errorHandler`. The `alreadyRecorded` check keeps that from becoming two errors.
- `info` says where the error was thrown: `render function` or `watcher callback` in development, a link like `https://vuejs.org/error-reference/#runtime-1` in production.
- An `errorCaptured` hook that returns `false` stops the error before it reaches `errorHandler`. Report it from that hook instead.
- Errors in navigation guards never reach `errorHandler`, which is why `traceRouter` reports them from `router.onError`.

## Tracing Nuxt: client plugin, vue:error, and the server-timing header

Nuxt runs on Vue Router, so `traceRouter` works unchanged. What's different is where the code goes. Nuxt has no `main.ts`, so the SDK, the router hooks, and error reporting go in a client-only plugin. Put `tracing.ts` and `router-tracing.ts` in `app/`:

```ts
// app/plugins/tracing.client.ts
// defineNuxtPlugin, useRouter and useRuntimeConfig are auto-imported
import { MapleBrowser } from "@maple-dev/browser"
import { traceRouter } from "../router-tracing"
import { alreadyRecorded } from "../tracing"

export default defineNuxtPlugin((nuxtApp) => {
	MapleBrowser.init({
		// runtimeConfig.public.mapleIngestKey in nuxt.config, set with NUXT_PUBLIC_MAPLE_INGEST_KEY
		ingestKey: useRuntimeConfig().public.mapleIngestKey as string,
		serviceName: "acme-web",
	})

	traceRouter(useRouter())

	// Nuxt calls this for every error a component throws
	nuxtApp.hook("vue:error", (error, _instance, info) => {
		if (!alreadyRecorded(error)) {
			MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
		}
	})
})
```

Nuxt calls `vue:error` from its root component's `errorCaptured` hook for every component error, and keeps logging them to the console, so there's no need to set `app.config.errorHandler`.

A page whose template throws during a client-side navigation renders twice, once when it mounts and again when `<NuxtPage>` updates it, and each render throws a new error. You get two `vue.error` spans for it. On a direct page load, the same error happens during the server render instead: Nuxt shows its 500 page, and the client plugin never sees it.

For data, wrap the function you pass to `useAsyncData`:

```ts
// In a page's <script setup>. useRoute, useAsyncData and $fetch are auto-imported
import { traced } from "~/tracing"

const route = useRoute()
const { data: project } = await useAsyncData(`project-${route.params.id}`, () =>
	traced("loader /projects/:id()", () => $fetch(`/api/projects/${route.params.id}`)),
)
```

During the server render the same call nests under the incoming request's span instead, and the browser doesn't run it again when it hydrates. If the function throws, `useAsyncData` puts the error in its `error` ref rather than passing it to `vue:error`, so the error is reported once, on the `loader` span.

### Link the Nuxt server render to the browser

Start the OpenTelemetry Node SDK with the setup file from the [Node.js guide](/docs/guides/instrumentation-nodejs), loaded in front of Nuxt's server build:

```bash
node --import ./instrumentation.mjs .output/server/index.mjs
```

Nuxt's server build is an ES module, and OpenTelemetry can only patch `node:http` for ES modules through its loader hook. Without it there's no request span, and no trace context to send to the browser. Register the hook in `instrumentation.mjs`, before the SDK starts:

```js
// instrumentation.mjs, before sdk.start()
import { register } from "node:module"

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)
```

That gives you a span for every incoming request, including the pages Nuxt renders. To join the browser's `pageload` span to it, add a Nitro plugin that writes the trace context into the `Server-Timing` header:

```ts
// server/plugins/traceparent.ts
// defineNitroPlugin is auto-imported
import { context, propagation } from "@opentelemetry/api"

export default defineNitroPlugin((nitroApp) => {
	nitroApp.hooks.hook("render:response", (response) => {
		// The HTTP instrumentation's request span is the active one here
		const carrier: Record<string, string> = {}
		propagation.inject(context.active(), carrier)
		if (carrier.traceparent) {
			response.headers = { ...response.headers, "server-timing": `traceparent;desc="${carrier.traceparent}"` }
		}
	})
})
```

Nitro calls `render:response` for every page Nuxt renders, before the headers are sent, and the request span is the active one there. Static files under `/_nuxt/` don't go through it, so they don't get the header. On the browser side, `serverContext()` in the helper reads the header, and the `pageload` span joins the server's trace.

The request span is named after the HTTP method, like `GET`. Nuxt renders a page in several steps, with no single call to wrap in a span of its own, so name the request span after the page's route instead, from a server-only plugin:

```ts
// app/plugins/ssr-span.server.ts
// defineNuxtPlugin and useRouter are auto-imported
import { trace } from "@opentelemetry/api"

export default defineNuxtPlugin(() => {
	useRouter().afterEach((to) => {
		trace.getActiveSpan()?.updateName(`ssr ${to.matched.at(-1)?.path ?? to.path}`)
	})
})
```

A page load then reads as one trace: `ssr /projects/:id()`, the `loader` span and its requests from the server render, and the browser's `pageload /projects/:id()` under it.

A few Nuxt details:

- **Route templates look different.** `pages/projects/[id].vue` becomes `/projects/:id()`, so the span is `navigate /projects/:id()`.
- **Route middleware isn't in the span.** Nuxt runs it in its own `beforeEach`, which is added before any plugin's.
- **The `pageload` span is short.** The first page's data is fetched during the server render and sent along in the payload, so that time shows up on the server side.
- **Your own API routes skip the network during the server render.** Nitro runs a `$fetch("/api/...")` handler in-process, so there's no HTTP span, and the `traced` span around it is the only record of its duration.
- **Cached pages share one trace.** If a CDN or a Nitro route rule like `swr` or `isr` caches the HTML, it caches the header too. Skip it on those routes.

## Vue-specific gotchas

- **axios uses `XMLHttpRequest` in the browser by default,** and only `fetch` is instrumented. Set `adapter: "fetch"` (axios 1.7 and later), or register OpenTelemetry's XHR instrumentation.
- **Route chunks that fail to load go to `router.onError`.** After a deploy, open tabs can ask for chunk files that no longer exist. Downloading a lazy route's chunk counts toward the navigation span, but has no span of its own, since a dynamic `import()` isn't a `fetch`.
- **Pages in `<KeepAlive>` don't rerun `setup`.** Going back to a cached page gives you a navigation span with no load span. Nothing was loaded, so that's accurate.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does Vue have built-in OpenTelemetry support?

No. Neither Vue nor Vue Router creates spans. Recent Nuxt versions have an experimental `tracingChannel` option that publishes render and data-fetching events on Node's diagnostics channels, but it doesn't create OpenTelemetry spans by itself. The router hooks used here are stable public API in both Vue Router 4 and 5.

### Why aren't my Vue component's requests in the navigation trace?

Usually one of three reasons. The request isn't inside `traced`, and the helper only parents spans started inside it. The request comes after an `await`, which loses the parent in the browser. Or it starts after the render, for example in a `setTimeout`, when the navigation span has already ended.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

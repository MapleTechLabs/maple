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
npm install @maple-dev/browser
```

This guide needs `@maple-dev/browser` 0.10.0 or later.

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

## Navigation and data-loading spans

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The SDK fixes that with a span per navigation, and the data-loading and `fetch` spans nested under it. Three calls do the work:

- `MapleBrowser.startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `MapleBrowser.endNavigation(route)` names the span after the route template and ends it.
- `MapleBrowser.traced(name, fn, { isFailure })` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`. An error it recorded isn't reported a second time by `captureException` or the SDK's global error handlers.

The Vue Router integration below connects the first two to the router, and your pages call `traced` for their data.

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

## Trace Vue Router navigations

`traceRouter` hooks into the router's `beforeEach`, `afterEach` and `onError` and turns each navigation into a span. Call it right after creating the router. Guards run in the order they were added, so adding it first puts your own guards, and the requests an auth guard makes, inside the span:

```ts
// src/router/index.ts
import { traceRouter } from "@maple-dev/browser/vue"
import { createRouter, createWebHistory } from "vue-router"
import { routes } from "./routes"

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })

// Before any other guard, so the navigation span covers them too
traceRouter(router)

export default router
```

The first navigation starts when `app.use(router)` installs the router, and becomes the `pageload` span. That span starts when your bundle runs, so it doesn't include downloading the HTML and JavaScript.

The span ends once Vue has rendered the new route, on the `nextTick` after `afterEach`, not when `afterEach` runs. By then the new page's `setup`, its immediate watchers, and its `onMounted` hooks have run, so anything they start lands inside the span.

### Route templates, redirects, and failed navigations

- **The span is named after the deepest matched route**, parents included, with params as placeholders: `/projects/:id`, not `/projects/8f2a`.
- **Redirects stay in one span.** When a guard returns a different location, or a route record declares a `redirect`, the navigation stays in the span its original location opened. A redirect to the login page is one `navigate /login` span with the original path in `url.path`.
- **Aborted navigations end normally.** A guard that returns `false` ends the span, named after the route the user tried to reach.
- **Replaced navigations end as interrupted.** That covers a click on another link while a navigation is still loading its route chunk or waiting on a guard, and a link back to the page on screen while one is pending. Its route never resolved, so the span keeps the plain name `navigate`. Most Vue navigations resolve at once, though, and it's the page's data loading that outlives them. That load span keeps running in the old trace, which is what happened.
- **A link to the current page starts no span.**
- **Query and hash changes are navigations.** A search page that syncs its filters to the URL gets a span per change, and so does a plain `<a href="#section">` link, because the router sees the browser's `popstate`.
- **Back and forward are navigations too.** They run the same guards, so each step is a `navigate` span, and the page loads its data again unless it's in `<KeepAlive>`.
- **Guard errors are reported.** An error thrown in a guard, or a route chunk that fails to load, is reported as `vue_router.error` and ends the span. Registering `router.onError` turns off Vue Router's own logging, so `traceRouter` logs these errors itself. If your own `onError` logs them too, you'll see them twice in the console.

## Trace data loading in Vue components

Vue Router doesn't load data for you. Most Vue apps fetch in the page component, in `setup`, `onMounted` or a watcher on the route params, and that code runs before the navigation span ends. Wrap it in `MapleBrowser.traced`, and name the span `loader` plus the route template, like the other framework guides:

```vue
<!-- src/pages/ProjectPage.vue -->
<script setup lang="ts">
import { MapleBrowser } from "@maple-dev/browser"
import { ref, watch } from "vue"
import { useRoute } from "vue-router"
import { type Project, fetchProject } from "../api"

const route = useRoute()
const project = ref<Project>()

watch(
	() => route.params.id as string,
	async (id) => {
		project.value = await MapleBrowser.traced("loader /projects/:id", () => fetchProject(id))
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

Vue Router guards redirect by returning a location, not by throwing, so `traced` needs no `isFailure` for router code. Where it does matter is aborted requests. If the id changes again before the first request finished, you usually want to cancel it:

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
			project.value = await MapleBrowser.traced("loader /projects/:id", () => fetchProject(id, controller.signal), {
				isFailure: () => !aborted(),
			})
		} catch (error) {
			if (!aborted()) throw error
		}
	},
	{ immediate: true },
)
```

The aborted fetch rejects with an `AbortError`. `isFailure` keeps it from marking the span as failed, and the `catch` keeps it away from Vue's error handler.

### Not-found pages

Vue Router has no not-found error either. A common pattern is to load the data, and on a 404 replace the route with the catch-all route while keeping the URL. Throw your own error class for the 404, and use `isFailure` to keep it from counting as a failure:

```ts
// Thrown by your API client on a 404
class NotFoundError extends Error {}

try {
	project.value = await MapleBrowser.traced("loader /projects/:id", () => fetchProject(id), {
		isFailure: (error) => !(error instanceof NotFoundError),
	})
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

## Report errors Vue catches with MapleVue

Vue catches errors thrown in components, watchers, lifecycle hooks, and event handlers, and passes them to `app.config.errorHandler`. Without one, development builds rethrow the error, so the SDK's global handlers see it.

Production builds only log it with `console.error`. That's how you end up with error reporting that works on your machine and reports nothing in production. `MapleVue` sets the handler:

```ts
// src/main.ts
import "./maple" // first, before anything renders
import { MapleVue } from "@maple-dev/browser/vue"
import { createApp } from "vue"
import App from "./App.vue"
import router from "./router"

const app = createApp(App)
app.use(MapleVue)
app.use(router)
app.mount("#app")
```

- Each error is reported as a `vue.error` span, with `vue.error.info` saying where it was thrown: `render function` or `watcher callback` in development, a link like `https://vuejs.org/error-reference/#runtime-1` in production.
- After reporting, the error goes back to Vue's own handling, so production builds still log it and development builds still warn and throw. If you set `app.config.errorHandler` before `app.use(MapleVue)`, your handler gets it instead.
- A failed `load project` records the error on its span and rethrows, and Vue passes the rejected watcher to the handler. `MapleVue` skips errors `traced` already recorded, so that stays one error.
- An `errorCaptured` hook that returns `false` stops the error before it reaches the handler. Report it from that hook with `reportVueError(error, instance, info)` from `@maple-dev/browser/vue`.
- Errors in navigation guards never reach the handler, which is why `traceRouter` reports them itself.

## Tracing Nuxt: client plugin, vue:error, and the server-timing header

Nuxt runs on Vue Router, so `traceRouter` works unchanged. What's different is where the code goes. Nuxt has no `main.ts`, so the SDK, the router tracing, and error reporting go in a client-only plugin:

```ts
// app/plugins/maple.client.ts
// defineNuxtPlugin, useRouter and useRuntimeConfig are auto-imported
import { MapleBrowser } from "@maple-dev/browser"
import { reportVueError, traceRouter } from "@maple-dev/browser/vue"

export default defineNuxtPlugin((nuxtApp) => {
	MapleBrowser.init({
		// runtimeConfig.public.mapleIngestKey in nuxt.config, set with NUXT_PUBLIC_MAPLE_INGEST_KEY
		ingestKey: useRuntimeConfig().public.mapleIngestKey as string,
		serviceName: "acme-web",
	})

	traceRouter(useRouter())

	// Nuxt calls this for every error a component throws
	nuxtApp.hook("vue:error", reportVueError)
})
```

Nuxt manages `app.config.errorHandler` itself, so use `reportVueError` from the `vue:error` hook instead of `MapleVue`. Nuxt calls that hook from its root component's `errorCaptured` hook for every component error, and keeps logging them to the console.

A page whose template throws during a client-side navigation renders twice, once when it mounts and again when `<NuxtPage>` updates it, and each render throws a new error. You get two `vue.error` spans for it. On a direct page load, the same error happens during the server render instead: Nuxt shows its 500 page, and the client plugin never sees it.

For data, wrap the function you pass to `useAsyncData`:

```ts
// In a page's <script setup>. useRoute, useAsyncData and $fetch are auto-imported
import { MapleBrowser } from "@maple-dev/browser"

const route = useRoute()
const { data: project } = await useAsyncData(`project-${route.params.id}`, () =>
	MapleBrowser.traced("loader /projects/:id()", () => $fetch(`/api/projects/${route.params.id}`)),
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

That gives you a span for every incoming request, including the pages Nuxt renders. Two plugins from `@maple-dev/browser/nuxt` connect it to the browser. A Nitro plugin writes the request span's trace context into a `Server-Timing` header, which the browser's `pageload` span joins:

```ts
// server/plugins/maple.ts
// defineNitroPlugin is auto-imported
import { mapleNitroPlugin } from "@maple-dev/browser/nuxt"

export default defineNitroPlugin(mapleNitroPlugin)
```

And a server-only Nuxt plugin names the request span after the page's route. Without it, the span keeps the HTTP method as its name, like `GET`, because Nuxt renders a page in several steps, with no single call to wrap in a span of its own:

```ts
// app/plugins/maple.server.ts
// defineNuxtPlugin and useRouter are auto-imported
import { nameSsrSpan } from "@maple-dev/browser/nuxt"

export default defineNuxtPlugin(() => nameSsrSpan(useRouter()))
```

A page load then reads as one trace: `ssr /projects/:id()`, the `loader` span and its requests from the server render, and the browser's `pageload /projects/:id()` under it.

- **Only rendered pages get the header.** Nitro calls the plugin's `render:response` hook for every page Nuxt renders, before the headers are sent. Static files under `/_nuxt/` and API routes don't go through it. If a `Server-Timing` header is already there, the value is appended.
- **Unmatched URLs keep the request span's own name**, like `GET`, rather than the concrete path.
- **`nameSsrSpan` renames the active span.** That's the HTTP instrumentation's request span, unless your app keeps its own span active around the router.

A few more Nuxt details:

- **Route templates look different.** `pages/projects/[id].vue` becomes `/projects/:id()`, so the span is `navigate /projects/:id()`.
- **Route middleware isn't in the span.** Nuxt runs it in its own `beforeEach`, which is added before any plugin's.
- **The `pageload` span is short.** The first page's data is fetched during the server render and sent along in the payload, so that time shows up on the server side.
- **Your own API routes skip the network during the server render.** Nitro runs a `$fetch("/api/...")` handler in-process, so there's no HTTP span, and the `traced` span around it is the only record of its duration.
- **Cached pages share one trace.** `mapleNitroPlugin` can't see route rules, so a page cached by a CDN or by a `swr`, `isr` or `cache` route rule keeps the header it was stored with, and every visitor joins the same trace. In that case, skip `mapleNitroPlugin` and add the header from your own `render:response` hook with `serverTiming()` from `@maple-dev/browser/server`, leaving out the cached routes.

## Vue-specific gotchas

- **axios uses `XMLHttpRequest` in the browser by default,** and only `fetch` is instrumented. Set `adapter: "fetch"` (axios 1.7 and later), or register OpenTelemetry's XHR instrumentation.
- **Route chunks that fail to load are reported by `traceRouter`.** After a deploy, open tabs can ask for chunk files that no longer exist. Downloading a lazy route's chunk counts toward the navigation span, but has no span of its own, since a dynamic `import()` isn't a `fetch`.
- **Pages in `<KeepAlive>` don't rerun `setup`.** Going back to a cached page gives you a navigation span with no load span. Nothing was loaded, so that's accurate.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does Vue have built-in OpenTelemetry support?

No. Neither Vue nor Vue Router creates spans. Recent Nuxt versions have an experimental `tracingChannel` option that publishes render and data-fetching events on Node's diagnostics channels, but it doesn't create OpenTelemetry spans by itself. `@maple-dev/browser/vue` uses router hooks that are stable public API in both Vue Router 4 and 5.

### Why aren't my Vue component's requests in the navigation trace?

Usually one of three reasons. The request isn't inside `MapleBrowser.traced`, which only parents requests started inside it. The request comes after an `await`, which loses the parent in the browser. Or it starts after the render, for example in a `setTimeout`, when the navigation span has already ended.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

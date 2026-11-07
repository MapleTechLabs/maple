---
title: "Frontend tracing for Vue, Vue Router and Nuxt"
description: "Trace Vue Router navigations, the data each page loads and the errors Vue catches with @maple-dev/browser, and join Nuxt's server render to the browser's page load."
group: "Frontend"
order: 4
navLabel: "Vue & Nuxt"
icon: "vue"
---

This page sets up frontend tracing for Vue 3 with Vue Router, and for Nuxt: a span per navigation, a span for the data each page loads with its `fetch` requests and backend spans underneath, and a report for every error Vue catches. The SDK has no Vue-specific entry, so a short helper connects Vue Router's guards to the SDK's navigation API.

It covers a Vue single-page app, then what changes in Nuxt, including joining the page load to the server render. Tested with Vue 3.5, Vue Router 5.4, Nuxt 4.6 and `@maple-dev/browser` 0.14.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this page.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Vue with Vue Router (or Nuxt).

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install and initialize

```bash
npm install @maple-dev/browser
```

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	environment: import.meta.env.MODE,
	tracing: {
		// Your API on another origin; same-origin requests carry the header already
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Import it on the first line of `src/main.ts` ([below](#report-errors-vue-catches)), so `init()` runs before the router's first navigation. EU organizations add `region: "eu"`. `init()` also traces `fetch` and `XMLHttpRequest` calls, reports uncaught errors and records the session replay; the [Browser SDK reference](/docs/session-replay/browser-sdk) lists every option.

`propagateTraceHeaderCorsUrls` makes requests to your API send `traceparent`, so its spans join the browser's trace. The API must run OpenTelemetry and allow the header in CORS (`Access-Control-Allow-Headers: traceparent, tracestate`), or the browser blocks the request. List only your own APIs.

## Trace Vue Router navigations

This helper opens a span in `beforeEach`, ends it once Vue has rendered the new route, and reports guard errors:

```ts
// src/trace-router.ts
import { MapleBrowser } from "@maple-dev/browser"
import { nextTick } from "vue"
import { isNavigationFailure, NavigationFailureType, type RouteLocation, type RouteLocationNormalized, type Router } from "vue-router"

// The deepest matched route, parents included: /projects/:id
const templateOf = (to: RouteLocationNormalized) => to.matched.at(-1)?.path
// A redirect runs the guards again for its target, with the original location as redirectedFrom
const originOf = (to: RouteLocationNormalized) => to.redirectedFrom ?? to

export function traceRouter(router: Router) {
	let current: RouteLocation | undefined // the location that opened the span in flight

	router.beforeEach((to) => {
		if (originOf(to) === current) return // a redirect stays in the span its original location opened
		current = originOf(to)
		MapleBrowser.startNavigation(to.path)
	})

	router.afterEach((to, _from, failure) => {
		// cancelled: a newer navigation already ended this one; duplicated: a link to the page on screen
		if (isNavigationFailure(failure, NavigationFailureType.cancelled | NavigationFailureType.duplicated)) return
		const origin = originOf(to)
		// After Vue renders the new route, so the page's setup runs inside the span
		void nextTick(() => {
			if (origin === current) MapleBrowser.endNavigation(templateOf(to))
		})
	})

	// A guard that throws, or a route chunk that fails to load, skips afterEach
	router.onError((error, to) => {
		if (originOf(to) === current) MapleBrowser.endNavigation(templateOf(to))
		MapleBrowser.captureException(error, { name: "vue_router.error" })
		console.error(error) // Vue Router stops logging errors once onError is set
	})
}
```

In `src/router/index.ts`, call `traceRouter(router)` right after `createRouter` and before adding your own guards, so the span covers them.

- The first navigation is a `pageload` span starting at the browser's navigation start; each later one is a `navigate` span in its own trace.
- Spans are named after the route template, parents included (`navigate /settings/profile/:tab`), with the concrete path in `url.path`. A catch-all route gives `navigate /:pathMatch(.*)*`.
- The span ends after Vue renders the new route, so requests the page starts in `setup`, an immediate watcher or `onMounted` nest under it.
- A redirect is one span named after the target. After a guard redirect, `url.path` is the original path (`navigate /login`, `url.path` `/private`).
- A guard returning `false` ends the span normally. A navigation that starts while another is pending ends the pending one with `maple.navigation.interrupted: true` and the bare name `navigate`.
- A link to the page on screen starts no span; a query or hash change does.
- A guard that throws, or a route chunk that fails to load, ends the span and is reported once as `vue_router.error`.

## Trace data loading

Pages usually fetch in `setup`. Wrap the page's load in `MapleBrowser.traced`, named `loader` plus the route template:

```vue
<!-- src/views/ProjectView.vue -->
<script setup lang="ts">
import { MapleBrowser } from "@maple-dev/browser"
import { ref, watch } from "vue"
import { useRoute } from "vue-router"
import { fetchProject, NotFoundError, type Project } from "../api"

const route = useRoute()
const project = ref<Project>()
const notFound = ref(false)

watch(
	() => route.params.id as string,
	async (id) => {
		try {
			project.value = await MapleBrowser.traced("loader /projects/:id", () => fetchProject(id), {
				isFailure: (error) => !(error instanceof NotFoundError), // a missing project isn't a failure
			})
			notFound.value = false
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error
			notFound.value = true
		}
	},
	{ immediate: true },
)
</script>

<template>
	<h1 v-if="notFound">Project not found</h1>
	<h1 v-else>{{ project?.name }}</h1>
</template>
```

`fetchProject` is your API client, which throws `NotFoundError` on a 404.

- `immediate: true` runs the watcher during `setup`, so the trace is `navigate /projects/:id` → `loader /projects/:id` → `GET` → your API's spans. From `/projects/1` to `/projects/2` the component is reused and the watcher runs inside that navigation.
- The `loader` span usually ends after the navigation span, which ends when the page renders.
- A load that throws is recorded once, on the `loader` span, and rethrown; the error handler below skips it.
- `isFailure` keeps the 404 from marking the span `Error`; use it the same way for an aborted request. The 404 `fetch` span is still `Error`, like every 4xx client span, but opens no issue.

The browser has no async context: only requests started before the first `await` inside `traced` nest under its span. Start independent requests together with `Promise.all`. For a dependent request, capture `const ctx = context.active()` (from `@opentelemetry/api`) before the first `await` and start it with `context.with(ctx, () => fetchMembers(project.id))`.

## Report errors Vue catches

Vue catches errors thrown in components, watchers, lifecycle hooks and event handlers, and production builds only log them, so the SDK's global handlers never see them. Report them from `app.config.errorHandler`:

```ts
// src/main.ts
import "./maple" // first: init() must run before the router's first navigation
import { MapleBrowser } from "@maple-dev/browser"
import { createApp } from "vue"
import App from "./App.vue"
import router from "./router"

const app = createApp(App)

app.config.errorHandler = (error, _instance, info) => {
	MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	console.error(error) // a handler replaces Vue's own logging
}

app.use(router)
app.mount("#app")
```

Each error becomes one `vue.error` span. `vue.error.info` says where Vue caught it: `render function` or `native event handler` in development, a link like `https://vuejs.org/error-reference/#runtime-1` in production.

## Nuxt

Nuxt runs on Vue Router: copy `src/trace-router.ts` from [above](#trace-vue-router-navigations) to `app/utils/trace-router.ts`.

### Client plugin

Nuxt has no `main.ts`; initialize the SDK and trace the router in a client-only plugin:

```ts
// app/plugins/maple.client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { traceRouter } from "~/utils/trace-router"

export default defineNuxtPlugin((nuxtApp) => {
	MapleBrowser.init({
		ingestKey: useRuntimeConfig().public.mapleIngestKey, // public key, maple_pk_...
		serviceName: "acme-web",
		tracing: {
			propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
		},
	})

	traceRouter(useRouter())

	// Nuxt owns app.config.errorHandler, and calls this hook for every error a component throws
	nuxtApp.hook("vue:error", (error, _instance, info) => {
		MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	})
})
```

Declare the key in `nuxt.config.ts` as `runtimeConfig: { public: { mapleIngestKey: "" } }` and set it with `NUXT_PUBLIC_MAPLE_INGEST_KEY`.

- Templates use Nuxt's syntax: `pages/projects/[id].vue` gives `navigate /projects/:id()`.
- Route middleware runs before the plugin's guard, so a middleware redirect is one span with the target's name and path.
- A URL no page matches keeps the bare name `navigate`. Nuxt then reloads it from the server, which gives a bare `pageload` for the 404 page.
- Nuxt calls `vue:error` asynchronously. In development, Vue rethrows an event handler's error first, so it arrives as `browser.uncaught_error`; production reports it as `vue.error`. Either way, once.

### Data loading with useAsyncData

Wrap the `useAsyncData` handler in `traced`:

```vue
<!-- app/pages/projects/[id].vue -->
<script setup lang="ts">
import { MapleBrowser } from "@maple-dev/browser"

const route = useRoute()
const { data: project, error } = await useAsyncData(`project-${route.params.id}`, () =>
	MapleBrowser.traced("loader /projects/:id()", () =>
		$fetch<{ name: string }>(`https://api.acme.com/projects/${route.params.id}`),
	),
)
</script>

<template>
	<h1 v-if="error">Could not load the project</h1>
	<h1 v-else>{{ project?.name }}</h1>
</template>
```

- On a client navigation, the handler runs under the `navigate` span.
- During the server render, `traced` only runs the handler, and hydration doesn't run it again: a page load has no `loader` span, the server's spans cover it.
- A handler that throws lands in `error`, not `vue:error`, and is recorded once, on the `loader` span.
- `$fetch` retries a failed `GET` once. The retry starts after an `await`, so it is a separate trace; pass `retry: 0` to turn it off.

### Join the page load to the server render

The browser's `pageload` span joins the server's trace when the page has a `<meta name="traceparent">` tag or a `Server-Timing: traceparent;desc="…"` header. The SDK doesn't write either: the server must run OpenTelemetry and add one. Install the Node SDK:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http import-in-the-middle
```

```js
// instrumentation.mjs
import { register } from "import-in-the-middle/register-hooks.mjs"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"

// Lets the instrumentations patch ES modules: Nitro's server build is ESM
register()

const sdk = new NodeSDK({
	serviceName: "acme-web-server",
	traceExporter: new OTLPTraceExporter({
		url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
		headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
	}),
	instrumentations: [
		getNodeAutoInstrumentations({
			// Hashed JS and CSS files: otherwise one trace per asset
			"@opentelemetry/instrumentation-http": {
				ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_nuxt/") ?? false,
			},
		}),
	],
})

sdk.start()
```

Set `MAPLE_INGEST_KEY` to a private key (`maple_sk_…`) and load the file before the server:

```bash
nuxt build
node --import ./instrumentation.mjs .output/server/index.mjs
```

A server-only plugin adds the tag and names the request span after the route:

```ts
// app/plugins/maple.server.ts
import { context, propagation, trace } from "@opentelemetry/api"

export default defineNuxtPlugin(() => {
	// The request's server span: the browser's page load joins its trace
	const carrier: { traceparent?: string } = {}
	propagation.inject(context.active(), carrier)
	if (carrier.traceparent) useHead({ meta: [{ name: "traceparent", content: carrier.traceparent }] })

	// Name that span after the page's route, ssr /projects/:id(), instead of GET
	useRouter().afterEach((to) => {
		const route = to.matched.at(-1)?.path
		if (route) trace.getActiveSpan()?.updateName(`ssr ${route}`)
	})
})
```

A page load is then one trace: `ssr /projects/:id()`, the server render's `fetch` and API spans under it, and the browser's `pageload /projects/:id()` as its child. Each reload is a new trace. Leave the tag out of prerendered or CDN-cached pages, or every visitor joins the trace the page was rendered in.

## Next steps

- [Browser SDK reference](/docs/session-replay/browser-sdk): sampling, consent, masking, logs and URL redaction.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

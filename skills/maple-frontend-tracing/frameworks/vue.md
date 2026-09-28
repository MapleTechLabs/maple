# Vue, Vue Router and Nuxt

Written against Vue 3.5, Vue Router 4.6 and 5.3, Nuxt 4.5. Human version: https://maple.dev/docs/frontend/vue

## Where things go (Vue SPA)

- `src/tracing.ts`: the helper, verbatim. `src/router-tracing.ts`: below; it imports `./tracing`.
- `src/main.ts`: `MapleBrowser.init(...)` before `createApp`, then `app.config.errorHandler` (see Caught errors) before `app.use(router)`.
- The router file (`src/router/index.ts` in the `create-vue` scaffold): `traceRouter(router)` right after `createRouter`.

Nuxt: see the Nuxt section instead.

## Navigations

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

Call `traceRouter(router)` right after `createRouter`, **before** other `beforeEach` guards are added, so the span covers them. The first navigation (on `app.use(router)`) becomes the `pageload` span; no `START_LOCATION` check needed.

- Template: `to.matched.at(-1)?.path` (`/projects/:id`).
- Redirect identity check: don't replace it with `if (!to.redirectedFrom)`; record-level `redirect` sets `redirectedFrom` without running guards for the original location.
- A record-level `redirect` (`{ path: "/old", redirect: "/projects/1" }`) is one span named after the target, with the target's `url.path`.
- Query/hash-only changes are navigations, including a plain `<a href="#section">` (the browser's `popstate` goes through the router): a `navigate <same template>` span with no load span. To skip them: return early in `beforeEach` when `from !== START_LOCATION && to.path === from.path`.
- Back/forward run the same guards: one `navigate` span per step, and the page's load runs again (except in `<KeepAlive>`).
- Interrupted: a navigation still resolving (lazy route chunk, async guard) when the next one starts ends as a plain `navigate` span with `app.navigation.interrupted`, without a template. Most Vue navigations resolve at once and their page-level load outlives them instead: that load span keeps running in the old trace, which is expected.

## Data loading

Vue Router has no loaders; page components fetch in `setup`, `onMounted` or a route-param watcher. Wrap the page-level load (not every component fetch), named `loader <template>`:

```ts
watch(
	() => route.params.id as string,
	async (id) => {
		project.value = await traced("loader /projects/:id", () => fetchProject(id))
	},
	{ immediate: true },
)
```

`immediate: true` runs it during `setup`, before the navigation span ends on `nextTick`. The load span usually ends after the navigation span; that's expected. Loads in `beforeResolve` / `beforeRouteEnter` also work with `traced`. Don't wrap Vue Router 5 experimental data loaders: `reroute()` throws and there's no public guard to exclude it.

If the load is cancelled with an `AbortController`, pass `() => !controller.signal.aborted` as `traced`'s third argument.

Vue Router has no not-found or redirect throws. If the load turns an API 404 into the catch-all route (`router.replace({ name: "not-found", params: { pathMatch: route.path.substring(1).split("/") }, query: route.query, hash: route.hash })`), throw your own error class for it and exclude it: `traced("loader /projects/:id", load, (error) => !(error instanceof NotFoundError))`. The replace is a second navigation, `navigate /:pathMatch(.*)*`, in its own trace. The 404 `fetch` span itself is marked Error by the SDK, like any 4xx client span.

## Caught errors

Without `app.config.errorHandler`, production builds only `console.error` component errors; the SDK never sees them. Setting the handler turns off Vue's logging, so keep it:

```ts
app.config.errorHandler = (error, _instance, info) => {
	console.error(error)
	if (!alreadyRecorded(error)) {
		MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	}
}
```

If a handler already exists, add the capture call inside it. Guard errors go to `router.onError` (handled in `traceRouter`). An `errorCaptured` hook returning `false` stops propagation: report there.

## Nuxt

Client-only plugin instead of `main.ts`; put `tracing.ts` and `router-tracing.ts` in `app/`:

```ts
// app/plugins/tracing.client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { traceRouter } from "../router-tracing"
import { alreadyRecorded } from "../tracing"

export default defineNuxtPlugin((nuxtApp) => {
	// Plus region, serviceVersion and tracing.propagateTraceHeaderCorsUrls as in SKILL.md Step 2
	MapleBrowser.init({ ingestKey: "MAPLE_TEST", serviceName: "acme-web" })

	traceRouter(useRouter())

	// Nuxt calls this for every component error, and keeps console logging
	nuxtApp.hook("vue:error", (error, _instance, info) => {
		if (!alreadyRecorded(error)) {
			MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
		}
	})
})
```

- Don't also set `app.config.errorHandler` in Nuxt.
- A page whose template throws during a client navigation renders twice (mount, then an update from `<NuxtPage>`), and each render throws a new `Error`: expect two `vue.error` spans. On a direct load the render error happens on the server (500 page) and the client plugin never sees it.
- Data: wrap the `useAsyncData` handler: `useAsyncData(key, () => traced("loader /projects/:id()", () => $fetch(url)))`. An error it throws lands in `useAsyncData`'s `error` ref, not in `vue:error`, so it's reported once. During the server render the same `traced` call nests under the request span; on hydration it doesn't run again.
- Templates look like `/projects/:id()`. Route middleware runs in Nuxt's own `beforeEach`, outside the span.

Server: Node SDK per `maple-nodejs-style`, preloaded: `node --import ./instrumentation.mjs .output/server/index.mjs`. Nitro's server build is ESM, so the setup file must register OpenTelemetry's ESM hook before starting the SDK, or `node:http` is never patched: no request span and no header. Put this before `sdk.start()` (with pnpm, add `@opentelemetry/instrumentation` as a direct dependency):

```js
import { register } from "node:module"
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)
```

Header via a Nitro plugin:

```ts
// server/plugins/traceparent.ts
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

Verified with Nuxt 4.5 (Nitro 2) on Node: the HTTP instrumentation's request span is active in `render:response`, only rendered pages get the header (not `/_nuxt/` assets), a reload gets a new trace id, and Nuxt sets no `ETag` on rendered HTML. Skip the header on `swr`/`isr` route rules and CDN-cached pages.

Nuxt has no single render call to wrap in an `ssr <template>` span, so name the request span instead, from a server-only plugin:

```ts
// app/plugins/ssr-span.server.ts
import { trace } from "@opentelemetry/api"

export default defineNuxtPlugin(() => {
	useRouter().afterEach((to) => {
		trace.getActiveSpan()?.updateName(`ssr ${to.matched.at(-1)?.path ?? to.path}`)
	})
})
```

## Gotchas

- axios in the browser uses XHR unless `adapter: "fetch"`.
- Lazy route chunk downloads count toward the navigation span with no child span; failed chunk loads after a deploy land in `router.onError`.
- `<KeepAlive>` pages don't rerun `setup`: no load span on return, which is accurate.

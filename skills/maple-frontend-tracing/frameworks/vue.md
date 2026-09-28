# Vue, Vue Router and Nuxt

Written against Vue 3.5, Vue Router 4.6 and 5.3, Nuxt 4.5. Human version: https://maple.dev/docs/frontend/vue

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
- Query/hash-only changes are navigations. To skip them: return early in `beforeEach` when `from !== START_LOCATION && to.path === from.path`.

## Data loading

Vue Router has no loaders; page components fetch in `setup` or a route-param watcher. Wrap the page-level load (not every component fetch):

```ts
watch(
	() => route.params.id as string,
	async (id) => {
		project.value = await traced("load project", () => fetchProject(id))
	},
	{ immediate: true },
)
```

`immediate: true` runs it during `setup`, before the navigation span ends on `nextTick`. The load span usually ends after the navigation span; that's expected. Loads in `beforeResolve` / `beforeRouteEnter` also work with `traced`. Don't wrap Vue Router 5 experimental data loaders: `reroute()` throws and there's no public guard to exclude it.

If the load is cancelled with an `AbortController`, pass `() => !controller.signal.aborted` as `traced`'s third argument.

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
- Data: wrap the `useAsyncData` handler: `useAsyncData(key, () => traced("load project", () => $fetch(url)))`.
- Templates look like `/projects/:id()`. Route middleware runs in Nuxt's own `beforeEach`, outside the span.

Server: Node SDK per `maple-nodejs-style`, preloaded: `node --import ./instrumentation.mjs .output/server/index.mjs`. Header via a Nitro plugin:

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

Not verified end to end: that the request span is active inside `render:response`. After deploying, check the document response for a `server-timing` header with a non-zero trace id and confirm the `pageload` span's parent. Skip the header on `swr`/`isr` route rules and CDN-cached pages.

## Gotchas

- axios in the browser uses XHR unless `adapter: "fetch"`.
- Lazy route chunk downloads count toward the navigation span with no child span; failed chunk loads after a deploy land in `router.onError`.
- `<KeepAlive>` pages don't rerun `setup`: no load span on return, which is accurate.

# Vue, Vue Router and Nuxt

Written against Vue 3.5, Vue Router 4.6 and 5.3, Nuxt 4.5, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/vue

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/vue` (router, errors) and `@maple-dev/browser/nuxt` (server plugins). Vue 3 with Vue Router 4 or 5.

## Vue SPA

Router file (`src/router/index.ts` in the `create-vue` scaffold), right after `createRouter`, **before** any other `beforeEach` guard, so the span covers them (an auth guard's `await` and requests):

```ts
import { traceRouter } from "@maple-dev/browser/vue"

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })
traceRouter(router)
```

`src/main.ts`: `MapleBrowser.init(...)` (or `import "./maple"`) before `createApp`, then `app.use(MapleVue)`:

```ts
import { MapleVue } from "@maple-dev/browser/vue"

const app = createApp(App)
app.use(MapleVue)
app.use(router)
app.mount("#app")
```

- `traceRouter`: a span per navigation, first one is `pageload`. Named after the deepest matched route (`/projects/:id`). Ends on the `nextTick` after `afterEach`, so the new page's `setup`, immediate watchers and `onMounted` work nests under it. Idempotent per router.
- Redirects (guard or record `redirect`) stay in the original span. A navigation replaced by a newer one, including a link back to the page on screen while one is pending, ends as interrupted with the plain name `navigate`. A link to the current page starts no span. Aborted (`return false`) ends normally, named after the target.
- Query and hash changes, back/forward: navigations.
- Guard errors and failed route chunks: reported as `vue_router.error` and logged (registering `router.onError` turns off Vue Router's own logging). An app that also logs in its own `onError` sees them twice in the console.
- `MapleVue` sets `app.config.errorHandler`: reports `vue.error` with `vue.error.info`, skips errors `traced` recorded, then hands the error back to Vue's default handling (prod logs, dev warns and throws) or to a handler set before `app.use(MapleVue)`. Don't hand-write an `errorHandler`; if the app sets one after `app.use(MapleVue)`, move it before, or call `reportVueError(error, instance, info)` from it.
- An `errorCaptured` hook that returns `false` stops propagation: call `reportVueError(error, instance, info)` there.

## Data loading (stays manual)

Vue Router has no loaders; pages fetch in `setup`, `onMounted` or a route-param watcher. Wrap the page-level load (not every component fetch), named `loader <template>`:

```ts
import { MapleBrowser } from "@maple-dev/browser"

watch(
	() => route.params.id as string,
	async (id) => {
		project.value = await MapleBrowser.traced("loader /projects/:id", () => fetchProject(id))
	},
	{ immediate: true },
)
```

- `immediate: true` runs it during `setup`, before the navigation span ends. The load span usually ends after the navigation span; expected. Loads in `beforeResolve` / `beforeRouteEnter` also work.
- Don't wrap Vue Router 5 experimental data loaders: `reroute()` throws and there's no public guard to exclude it.
- Cancelled with an `AbortController`: `{ isFailure: () => !controller.signal.aborted }`, and swallow the abort in a `catch`.
- API 404 turned into the catch-all route (`router.replace({ name: "not-found", params: { pathMatch: route.path.substring(1).split("/") }, query: route.query, hash: route.hash })`): throw your own error class and exclude it, `{ isFailure: (error) => !(error instanceof NotFoundError) }`. The replace is its own trace, `navigate /:pathMatch(.*)*`. The 404 `fetch` span is Error, like any 4xx client span.

## Nuxt

Client-only plugin instead of `main.ts`. Nuxt owns `app.config.errorHandler`: use `reportVueError` on `vue:error`, not `MapleVue`:

```ts
// app/plugins/maple.client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { reportVueError, traceRouter } from "@maple-dev/browser/vue"

export default defineNuxtPlugin((nuxtApp) => {
	// Plus region, serviceVersion and tracing.propagateTraceHeaderCorsUrls as in SKILL.md Step 2
	MapleBrowser.init({ ingestKey: "MAPLE_TEST", serviceName: "acme-web" })
	traceRouter(useRouter())
	nuxtApp.hook("vue:error", reportVueError)
})
```

- A page whose template throws during a client navigation renders twice: expect two `vue.error` spans. On a direct load the render error happens on the server (500 page); the client plugin never sees it.
- Data: `useAsyncData(key, () => MapleBrowser.traced("loader /projects/:id()", () => $fetch(url)))`. Its error lands in `useAsyncData`'s `error` ref, not `vue:error`: reported once. During SSR the same call spans under the request span; on hydration it doesn't run again.
- Templates look like `/projects/:id()`. Nuxt route middleware runs in Nuxt's own `beforeEach`, registered before any plugin's: outside the span.

Server: Node SDK per `maple-nodejs-style`, preloaded: `node --import ./instrumentation.mjs .output/server/index.mjs`. Nitro's build is ESM, so the setup file must register OpenTelemetry's ESM hook before starting the SDK, or `node:http` is never patched (no request span, no header). Before `sdk.start()` (with pnpm, add `@opentelemetry/instrumentation` as a direct dependency):

```js
import { register } from "node:module"
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)
```

Then two plugins:

```ts
// server/plugins/maple.ts: Server-Timing on rendered pages
import { mapleNitroPlugin } from "@maple-dev/browser/nuxt"

export default defineNitroPlugin(mapleNitroPlugin)
```

```ts
// app/plugins/maple.server.ts: names the request span `ssr /projects/:id()`
import { nameSsrSpan } from "@maple-dev/browser/nuxt"

export default defineNuxtPlugin(() => nameSsrSpan(useRouter()))
```

- `mapleNitroPlugin` appends to an existing `Server-Timing` header (any casing), only on rendered pages (not `/_nuxt/` assets or API routes). Nuxt sets no `ETag` on rendered HTML.
- It can't see route rules: pages cached by `swr`/`isr`/`cache` rules or a CDN keep their header, so every visitor joins one trace. Those apps: skip `mapleNitroPlugin`, add the header from their own `render:response` hook with `serverTiming()` from `@maple-dev/browser/server`, leaving out the cached routes.
- `nameSsrSpan` renames the active span (the HTTP instrumentation's request span unless the app keeps its own span active). Unmatched URLs keep the span's own name (`GET`).

## Gotchas

- axios in the browser uses XHR unless `adapter: "fetch"`.
- Lazy route chunk downloads count toward the navigation span with no child span; failed chunk loads after a deploy are reported by `traceRouter` as `vue_router.error`.
- `<KeepAlive>` pages don't rerun `setup`: no load span on return, which is accurate.

## Check

Production build (`vite build` + `vite preview`, or `nuxt build` + the `node --import` command), in addition to `SKILL.md` Step 7:

- Click: one `navigate /projects/:id` with the `loader` span and `fetch` spans under it. A redirect (`/old`) is one span named after the target.
- Nuxt page load: `ssr /projects/:id()` → SSR `loader` → `fetch` → API, `pageload /projects/:id()` its child; header on HTML only; new trace per reload.
- A load that throws: one `exception` event (on the `loader` span). A component error: one `vue.error` (two for a Nuxt template error on client navigation, see above).

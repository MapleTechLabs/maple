# Vue, Vue Router and Nuxt

Tested with Vue 3.5, Vue Router 5.4, Nuxt 4.6, `@maple-dev/browser` 0.14. Human version: https://maple.dev/docs/frontend/vue

No `@maple-dev/browser/vue` or `/nuxt` entry exists. Wire the core API to Vue Router's guards and Vue's error hook as below.

## Vue SPA

1. `src/maple.ts` with `MapleBrowser.init(...)` (`SKILL.md` Step 2); `import "./maple"` as the **first** line of `src/main.ts`, so `init()` runs before `app.use(router)` starts the page load.
2. `src/trace-router.ts` as below; call `traceRouter(router)` right after `createRouter`, **before** any other guard:

```ts
import { MapleBrowser } from "@maple-dev/browser"
import { nextTick } from "vue"
import { isNavigationFailure, NavigationFailureType, type RouteLocation, type RouteLocationNormalized, type Router } from "vue-router"

const templateOf = (to: RouteLocationNormalized) => to.matched.at(-1)?.path
const originOf = (to: RouteLocationNormalized) => to.redirectedFrom ?? to

export function traceRouter(router: Router) {
	let current: RouteLocation | undefined

	router.beforeEach((to) => {
		if (originOf(to) === current) return // a redirect stays in the original span
		current = originOf(to)
		MapleBrowser.startNavigation(to.path)
	})

	router.afterEach((to, _from, failure) => {
		if (isNavigationFailure(failure, NavigationFailureType.cancelled | NavigationFailureType.duplicated)) return
		const origin = originOf(to)
		// After Vue renders the new route, so the page's setup runs inside the span
		void nextTick(() => {
			if (origin === current) MapleBrowser.endNavigation(templateOf(to))
		})
	})

	router.onError((error, to) => {
		if (originOf(to) === current) MapleBrowser.endNavigation(templateOf(to))
		MapleBrowser.captureException(error, { name: "vue_router.error" })
		console.error(error) // Vue Router stops logging once onError is set
	})
}
```

3. `src/main.ts`, before `app.use(router)`; fold any existing handler's logic into it:

```ts
app.config.errorHandler = (error, _instance, info) => {
	MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	console.error(error) // a handler replaces Vue's own logging
}
```

4. Wrap each page-level load (not every component fetch) in `traced`, named `loader <template>`, started during `setup`:

```ts
watch(
	() => route.params.id as string,
	async (id) => {
		project.value = await MapleBrowser.traced("loader /projects/:id", () => fetchProject(id), {
			isFailure: (error) => !(error instanceof NotFoundError), // only if the app models 404s as a throw
		})
	},
	{ immediate: true },
)
```

- Expected throws (404 class, the page's own aborts): exclude with `isFailure` and catch them, so they don't reach `errorHandler`.
- The `loader` span ending after the navigation span is expected. Requests after an `await`: `SKILL.md` Step 4.

## Nuxt

Copy `trace-router.ts` to `app/utils/trace-router.ts`. Nuxt owns `app.config.errorHandler`: use the `vue:error` hook, not `errorHandler`.

```ts
// app/plugins/maple.client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { traceRouter } from "~/utils/trace-router"

export default defineNuxtPlugin((nuxtApp) => {
	MapleBrowser.init({
		ingestKey: useRuntimeConfig().public.mapleIngestKey, // nuxt.config runtimeConfig.public.mapleIngestKey, NUXT_PUBLIC_MAPLE_INGEST_KEY
		serviceName: "acme-web",
		// plus region / propagateTraceHeaderCorsUrls per SKILL.md Step 2
	})
	traceRouter(useRouter())
	nuxtApp.hook("vue:error", (error, _instance, info) => {
		MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	})
})
```

- Data: `useAsyncData(key, () => MapleBrowser.traced("loader /projects/:id()", () => $fetch(url)))`. Errors land in `error`, recorded once on the `loader` span. SSR: `traced` only runs `fn`; no browser `loader` span on a page load.
- Templates look like `/projects/:id()`. Middleware redirects: one span, named after the target.
- `$fetch` retries a failed GET once, as its own root trace (`retry: 0` turns it off).

SSR join (server-rendered apps whose start command you control):

1. Server OTel, as in the human guide's `instrumentation.mjs`: `npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http import-in-the-middle`; call `register()` from `import-in-the-middle/register-hooks.mjs` **before** `new NodeSDK(...)` (Nitro's output is ESM); `serviceName: "<app>-web-server"`; `OTLPTraceExporter` to `https://ingest(.eu).maple.dev/v1/traces` with `Bearer <maple_sk_…>`; `getNodeAutoInstrumentations` with `ignoreIncomingRequestHook` dropping `/_nuxt/`. Start with `node --import ./instrumentation.mjs .output/server/index.mjs`.
2. `app/plugins/maple.server.ts`:

```ts
import { context, propagation, trace } from "@opentelemetry/api"

export default defineNuxtPlugin(() => {
	const carrier: { traceparent?: string } = {}
	propagation.inject(context.active(), carrier)
	if (carrier.traceparent) useHead({ meta: [{ name: "traceparent", content: carrier.traceparent }] })
	useRouter().afterEach((to) => {
		const route = to.matched.at(-1)?.path
		if (route) trace.getActiveSpan()?.updateName(`ssr ${route}`)
	})
})
```

3. Skip prerendered or cached pages: the tag is baked in and every visitor joins one trace.

## Check

`SKILL.md` Step 7, plus:

- SPA reload: one `pageload /projects/:id` → `loader` → `GET` → API. Nuxt SSR: the HTML has `<meta name="traceparent">` and `pageload /projects/:id()` has the `ssr /projects/:id()` span as parent; each reload is a new trace.
- A redirect: one span named after the target. A link to the current page: none.
- A loader that throws: one `exception`, on the `loader` span, no `vue.error`. A throwing click handler or render: one `vue.error` (Nuxt dev: `browser.uncaught_error`). A throwing guard: one `vue_router.error`, span still ends.

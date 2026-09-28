# SvelteKit

Written against `@sveltejs/kit` 2.70 and `svelte` 5.57. Human version: https://maple.dev/docs/frontend/sveltekit

Put `maple.ts` (the `MapleBrowser.init` call) and `tracing.ts` in `src/lib/`. Install `@opentelemetry/api` next to `@maple-dev/browser`: `tracing.ts` and `hooks.server.ts` import it.

## Init and first load

`beforeNavigate` doesn't fire for the first load, so open the `pageload` span from the client `init` hook:

```ts
// src/hooks.client.ts
import "$lib/maple" // first: starts the SDK before anything else runs
import { MapleBrowser } from "@maple-dev/browser"
import type { ClientInit, HandleClientError } from "@sveltejs/kit"
import { alreadyRecorded, startNavigation } from "$lib/tracing"

export const init: ClientInit = () => {
	// Runs once, before hydration and before the first page's load functions
	startNavigation(location.pathname)
}

export const handleError: HandleClientError = ({ error, status }) => {
	// Unknown routes also end up here, as a 404
	if (status === 404) return
	if (!alreadyRecorded(error)) MapleBrowser.captureException(error, { name: "sveltekit.client_error" })
}
```

If `hooks.client.ts` already exports `handleError`, add the capture call inside it and keep what it returns.

## Navigations

In the **root** `+layout.svelte` (nested layouts miss navigations outside them):

```svelte
<script lang="ts">
	import { afterNavigate, beforeNavigate } from "$app/navigation"
	import { navigating, page } from "$app/state"
	import { endNavigation, startNavigation } from "$lib/tracing"

	let { children } = $props()

	beforeNavigate((navigation) => {
		// External links and closing the tab load a new document with its own pageload span
		if (navigation.willUnload || !navigation.to) return
		startNavigation(navigation.to.url.pathname)

		// Rejects when the navigation is cancelled, or overtaken by a newer one
		navigation.complete.catch(() => {
			// If a newer navigation is still loading, the span belongs to it now
			if (!navigating.type) endNavigation()
		})
	})

	afterNavigate(() => {
		// On the first load, navigation.to.route.id is null; page.route.id is always set
		endNavigation(page.route.id ?? undefined)
	})
</script>

{@render children()}
```

Merge into the existing root layout's `<script>`; keep its props and markup. If `$app/state` isn't available (older SvelteKit), use `get(navigating)` (null when idle) and `get(page).route.id` from `$app/stores`.

- Template: route id (`/projects/[id]`). It includes route groups (`/(app)/projects/[id]`); keep them, SvelteKit's server `http.route` uses the same string.
- A click during a pending navigation doesn't fire `beforeNavigate`; the `navigating.type` check keeps one span for both, named after the final route, with `url.path` from the first click and both routes' load spans under it.
- `redirect()` in a load navigates internally without `beforeNavigate`; the span ends named after the destination, with the redirecting load's span and the destination's under it.
- Back/forward fire both hooks: each is a `navigate` span, and the page's universal loads run again under it.
- Query-only changes (`?tab=members`) are navigations: a `navigate` span, with load spans only for loads that read `url.searchParams`.
- Hash-only links, `invalidate()`, `invalidateAll()` and shallow routing (`pushState`/`replaceState` from `$app/navigation`) fire neither hook.
- A link to a path no route matches reloads the document: the new page's span is a bare `pageload` (no route id to name it after).

## Load functions

```ts
// src/lib/load-span.ts
import { browser } from "$app/environment"
import { isHttpError, isRedirect } from "@sveltejs/kit"
import { traced } from "./tracing"

// redirect() and error(404) are control flow, not failures
const isFailure = (error: unknown) => !isRedirect(error) && !(isHttpError(error) && error.status < 500)

/** Trace a universal load function while it runs in the browser. */
export const loadSpan = <T>(name: string, fn: () => Promise<T>) =>
	// On the server, SvelteKit's own tracing already records a span per load
	browser ? traced(name, fn, isFailure) : fn()
```

```ts
// src/routes/projects/[id]/+page.ts
import { error } from "@sveltejs/kit"
import { loadSpan } from "$lib/load-span"
import type { PageLoad } from "./$types"

export const load: PageLoad = async ({ fetch, params, route }) =>
	loadSpan(`loader ${route.id}`, async () => {
		const [project, members] = await Promise.all([
			fetch(`/api/projects/${params.id}`),
			fetch(`/api/projects/${params.id}/members`),
		])
		if (project.status === 404) error(404, "Project not found")
		return { project: await project.json(), members: await members.json() }
	})
```

- Wrap universal loads (`+page.ts`, `+layout.ts`) only. Server loads (`+page.server.ts`) are traced by SvelteKit on the server. Their `__data.json` request starts outside any `traced` call, so it and the server's `sveltekit.load` span form their own trace, not a child of the `navigate` span.
- Keep typed loads `async`; a non-async arrow returning `loadSpan(...)` can infer `data` as `{}`.
- Use the `fetch` SvelteKit passes to `load` so requests go through the SDK.
- During hydration, loads rerun against inlined responses, so first-load load spans are ~0ms.
- Preloads on hover (`data-sveltekit-preload-data="hover"`, the default template) run the loads before the click, as their own traces (a root `loader` span with its fetches). The `navigate` span after the click then has no load or fetch children and lasts a few ms. That's expected; don't change the preload setting to get them back.
- `error(404)` after a 404 API response: the navigation and load spans stay OK. The `fetch` span for the 404 itself is Error, as for any 4xx client request.

## Render errors

Without `experimental.handleRenderingErrors`, SvelteKit doesn't catch errors thrown while a component renders:

- In the browser they reach `window.onerror`, and the SDK reports them once as `browser.uncaught_error`. `handleError` isn't called.
- During SSR the response is a 500 and the server span is Error, but no span records the exception.

With `handleRenderingErrors: true` (experimental; it also renders `+error.svelte` in place of the broken component), client render errors go through `handleError` and are reported once as `sveltekit.client_error`. Enable it only if the user wants that behavior change.

## Server side

SvelteKit 2.31+ has built-in, **experimental** server OpenTelemetry. Enable both flags where the project keeps its SvelteKit config. Projects scaffolded by `sv create` on SvelteKit 2.62+ pass it to the `sveltekit()` Vite plugin and have no `svelte.config.js`; there the flags go at the top level of the plugin options, with no `kit` key:

```ts
// vite.config.ts
sveltekit({
	adapter: adapter(),
	experimental: {
		tracing: { server: true },
		instrumentation: { server: true },
	},
})
```

With a `svelte.config.js`, the same `experimental` object goes under `kit`. SvelteKit ignores `svelte.config.js` when options are passed to `sveltekit()`.

Install `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-proto` and `import-in-the-middle` as `dependencies`, not `devDependencies`: `adapter-node` bundles devDependencies into the build, and it keeps `dependencies` as runtime imports.

Start the Node SDK in `src/instrumentation.server.ts` (loaded before app code; confirmed for `adapter-node`, check other adapters):

```ts
// src/instrumentation.server.ts
import { register } from "node:module"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { createAddHookMessageChannel } from "import-in-the-middle"

// Lets the auto-instrumentations patch ES modules, not only CommonJS
const { registerOptions } = createAddHookMessageChannel()
register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions)

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "MAPLE_TEST" // ingest key, inline

const sdk = new NodeSDK({
	serviceName: "acme-web-server",
	traceExporter: new OTLPTraceExporter({
		url: `${MAPLE_ENDPOINT}/v1/traces`,
		headers: { authorization: `Bearer ${MAPLE_KEY}` },
	}),
	instrumentations: [
		getNodeAutoInstrumentations({
			// Hashed JS and CSS files: otherwise one trace per asset on every page load
			"@opentelemetry/instrumentation-http": {
				ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_app/immutable/") ?? false,
			},
		}),
	],
})

sdk.start()
```

`/_app` is the default `kit.appDir`; use the project's value if it sets one.

Spans you get: the HTTP server span from the Node instrumentation, with `sveltekit.handle.root` (with `http.route`), `sveltekit.resolve` and `sveltekit.load` per load (`sveltekit.load.node_id` names the file) under it. Don't add your own render span. Errors thrown in a load are recorded on its `sveltekit.load` span; don't add a server `handleError` that records them again.

Header for the browser's pageload span, in `hooks.server.ts` (compose with an existing `handle` via `sequence` from `@sveltejs/kit/hooks`):

```ts
import { context, propagation, trace } from "@opentelemetry/api"
import type { Handle } from "@sveltejs/kit"

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event)

	if (response.headers.get("content-type")?.startsWith("text/html")) {
		const carrier: Record<string, string> = {}
		propagation.inject(trace.setSpan(context.active(), event.tracing.root), carrier)
		// Empty when tracing is off: event.tracing.root is then a no-op span
		if (carrier.traceparent) {
			response.headers.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
			// Otherwise a 304 revalidation reuses the cached header, and an old trace
			response.headers.delete("etag")
		}
	}

	return response
}
```

- SPA / `adapter-static`: skip this section; the pageload span starts its own trace.
- Node 26 prints a deprecation warning for `module.register()`; it still works.

# SvelteKit

Written against `@sveltejs/kit` 2.70 and `svelte` 5.57. Human version: https://maple.dev/blog/frontend-tracing-sveltekit

Put `maple.ts` (the `MapleBrowser.init` call) and `tracing.ts` in `src/lib/`.

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
- A click during a pending navigation doesn't fire `beforeNavigate`; the `navigating.type` check keeps one span for both.
- `redirect()` in a load navigates internally without `beforeNavigate`; the span ends named after the destination.
- Hash-only links, `invalidate()`, `invalidateAll()` and shallow routing (`pushState`/`replaceState` from `$app/navigation`) fire neither hook.

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
export const load: PageLoad = async ({ fetch, params, route }) =>
	loadSpan(`load ${route.id}`, async () => {
		const [project, members] = await Promise.all([
			fetch(`/api/projects/${params.id}`),
			fetch(`/api/projects/${params.id}/members`),
		])
		return { project: await project.json(), members: await members.json() }
	})
```

- Wrap universal loads (`+page.ts`, `+layout.ts`) only. Server loads (`+page.server.ts`) are traced by SvelteKit on the server, and their `__data.json` request carries `traceparent`.
- Keep typed loads `async`; a non-async arrow returning `loadSpan(...)` can infer `data` as `{}`.
- Use the `fetch` SvelteKit passes to `load` so requests go through the SDK.
- During hydration, loads rerun against inlined responses, so first-load load spans are ~0ms. Preloads on hover (`data-sveltekit-preload-data="hover"`, the default template) produce their own traces.

## Server side

SvelteKit 2.31+ has built-in, **experimental** server OpenTelemetry. Enable both flags:

```js
// svelte.config.js
kit: {
	experimental: {
		tracing: { server: true },
		instrumentation: { server: true },
	},
}
```

Start the Node SDK in `src/instrumentation.server.ts` (loaded before app code; confirmed for `adapter-node`, check other adapters). Use `NodeSDK` with `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-proto`, the key inline per `maple-nodejs-style`, `getNodeAutoInstrumentations()`, and register the ESM hook with `import-in-the-middle` (`createAddHookMessageChannel` + `register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions)`).

Spans you get: `sveltekit.handle.root` (with `http.route`), `sveltekit.resolve`, `sveltekit.load` per load (`sveltekit.load.node_id` names the file). Don't add your own render span.

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

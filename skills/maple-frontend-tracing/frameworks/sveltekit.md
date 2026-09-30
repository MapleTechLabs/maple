# SvelteKit

Written against `@sveltejs/kit` 2.70, `svelte` 5.57, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/sveltekit

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/sveltekit` (client hooks, root layout, loads) and `@maple-dev/browser/sveltekit/server` (`handle`). Needs SvelteKit 2.10+ (the `init` hook); the server header needs 2.31+ server tracing. Put `maple.ts` (the `MapleBrowser.init` call) in `src/lib/`.

## Client hooks

```ts
// src/hooks.client.ts
import "$lib/maple" // first: starts the SDK before anything else runs
import { handleErrorWithMaple, startPageLoad } from "@maple-dev/browser/sveltekit"

export const init = startPageLoad
export const handleError = handleErrorWithMaple()
```

- `startPageLoad` must be the `init` hook (`beforeNavigate` doesn't fire for the first load). If `init` already exists, call `startPageLoad()` first inside it. Without it, the first click is recorded as the `pageload`.
- Existing `handleError`: `export const handleError = handleErrorWithMaple(existingHandleError)`; what it returns is kept.
- `handleErrorWithMaple` reports `sveltekit.client_error`, skips 404s (unknown routes) and errors `loadSpan` recorded.

## Navigations

In the **root** `+layout.svelte` (nested layouts miss navigations outside them). Merge into the existing `<script>`; keep its props and markup:

```svelte
<script lang="ts">
	import { afterNavigate, beforeNavigate } from "$app/navigation"
	import { navigating, page } from "$app/state"
	import { traceNavigation } from "@maple-dev/browser/sveltekit"

	let { children } = $props()

	traceNavigation({ beforeNavigate, afterNavigate, navigating, page })
</script>

{@render children()}
```

- The `$app` imports are passed in because only the app can resolve them. SvelteKit 2.10/2.11 (no `$app/state`): pass `navigating: { get type() { return get(navigatingStore)?.type ?? null } }` and `page: { get route() { return get(pageStore).route } }`, stores from `$app/stores`, `get` from `svelte/store`.
- Template: route id (`/projects/[id]`), route groups kept (same string as SvelteKit's server `http.route`).
- A click or back during a pending navigation: one span, named after the final route, `url.path` from the first click. `redirect()` in a load stays in the span, named after the destination.
- `cancel()` in a `beforeNavigate` guard ends the span as interrupted (plain `navigate`, ~0 ms).
- Back/forward and query-only changes are navigations. Hash links, `invalidate()`, `invalidateAll()`, shallow routing and leaving the app start nothing. A link no route matches reloads the document: bare `pageload`.
- Hash routing (`router.type: "hash"`): names are right, `url.path` is the document's path (`/`).

## Load functions

Wrap universal loads (`+page.ts`, `+layout.ts`):

```ts
// src/routes/projects/[id]/+page.ts
import { loadSpan } from "@maple-dev/browser/sveltekit"
import { error } from "@sveltejs/kit"
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

- `redirect()` and `error()` below 500 aren't failures. On the server `loadSpan` only runs `fn` (SvelteKit's own tracing spans each load).
- Server loads (`+page.server.ts`) are traced by SvelteKit on the server; their `__data.json` request starts outside any span, so it and the server's `sveltekit.load` span form their own trace.
- Keep typed loads `async`; a non-async arrow returning `loadSpan(...)` can infer `data` as `{}`.
- Use the `fetch` SvelteKit passes to `load` so requests go through the SDK.
- During hydration, loads rerun against inlined responses: first-load load spans are ~0 ms.
- Preloads on hover (`data-sveltekit-preload-data="hover"`, the default template) run loads before the click, as their own traces; the `navigate` span after the click then has no children. Expected; don't change the preload setting.
- `error(404)` after a 404 API response: navigation and load spans stay OK; the 404 `fetch` span is Error, like any 4xx client span.
- The browser tracing code is imported on the server too (root layout, universal loads). It does nothing there, but bundling adapters ship it in the server bundle.

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

Header for the browser's pageload span:

```ts
// src/hooks.server.ts
import { mapleHandle } from "@maple-dev/browser/sveltekit/server"

export const handle = mapleHandle
```

- Existing `handle`: `export const handle = sequence(mapleHandle, existingHandle)` (`sequence` from `@sveltejs/kit/hooks`), `mapleHandle` first.
- Adds `Server-Timing` from `event.tracing.root` on HTML responses and drops their `ETag` (a 304 revalidation would reuse the cached header and an earlier trace). Passes through without server tracing, before 2.31, and for immutable responses.
- CDN-cached pages: skip `mapleHandle` for them, or every visitor joins one trace.
- SPA / `adapter-static`: skip this section; the pageload span starts its own trace.
- Node 26 prints a deprecation warning for `module.register()`; it still works.

## Check

Production build (`vite build`, `node build`), in addition to `SKILL.md` Step 7:

- Page load `/projects/1`: `pageload /projects/[id]` child of `sveltekit.handle.root`; no `ETag` on the HTML; no header on `__data.json`; reload gets a new trace.
- Click: `navigate /projects/[id]` → `loader /projects/[id]` → `fetch` spans. `/old` redirect: one span, `url.path=/old`, both loaders under it.
- A load that throws (client and SSR): one `exception` event.

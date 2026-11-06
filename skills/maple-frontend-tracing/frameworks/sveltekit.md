# SvelteKit

Written against `@sveltejs/kit` 3.1, `svelte` 5.57, `@sveltejs/adapter-node` 6, `@maple-dev/browser` 0.14. Human version: https://maple.dev/docs/frontend/sveltekit

There is no SvelteKit entry in the SDK. Wire SvelteKit's hooks to the core API (`MapleBrowser.startNavigation`, `endNavigation`, `traced`, `captureException`) as below. SvelteKit 3: hook types come from `@sveltejs/kit/hooks`, `$lib` is `#lib`, config lives in the `sveltekit()` options in `vite.config.ts` (no `svelte.config.js`), and `handleError` gets `kind`. On SvelteKit 2, check the installed types before copying.

## Client hooks

Init the SDK in `src/hooks.client.ts` (browser only). Merge into an existing file; if `init` or `handleError` exist, add these calls inside them.

```ts
// src/hooks.client.ts
import { MapleBrowser } from "@maple-dev/browser"
import type { ClientInit, HandleClientError } from "@sveltejs/kit/hooks"

MapleBrowser.init({
	ingestKey: "MAPLE_TEST", // public key, maple_pk_…
	serviceName: "acme-web",
	region: "us", // "eu" for EU organizations
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

// Runs once, before hydration and the first page's load functions
export const init: ClientInit = () => MapleBrowser.startNavigation(location.pathname)

export const handleError: HandleClientError = ({ kind, error }) => {
	// "app" is error(), "framework" is SvelteKit's own (404s): only "unknown" is a bug
	if (kind === "unknown") MapleBrowser.captureException(error, { name: "sveltekit.client_error" })
}
```

- `init` must open the page load: `beforeNavigate` doesn't fire for it.
- Use RegExps in `propagateTraceHeaderCorsUrls` (strings are exact-match on 0.14.0).

## Navigations

In the **root** `src/routes/+layout.svelte` (nested layouts miss navigations outside them). Merge into the existing `<script>`; keep its props and markup.

```svelte
<script lang="ts">
	import { MapleBrowser } from "@maple-dev/browser"
	import { afterNavigate, beforeNavigate } from "$app/navigation"
	import { navigating, page } from "$app/state"

	let { children } = $props()

	beforeNavigate(({ to, willUnload, complete }) => {
		if (willUnload || !to) return // leaving the app, or a link no route matches
		MapleBrowser.startNavigation(to.url.pathname)
		// A beforeNavigate guard called cancel(): end the span instead of leaving it open
		complete.catch(() => {
			if (!navigating.type) MapleBrowser.endNavigation()
		})
	})

	// page.route.id, not to.route.id: SvelteKit 3.1 passes a null route id on the first load
	afterNavigate(() => MapleBrowser.endNavigation(page.route.id ?? undefined))
</script>

{@render children()}
```

- Name = route id (`/projects/[id]`, groups kept), same string as SvelteKit's server `http.route`.
- Don't use `to.route.id` in `afterNavigate`: null on the first load (kit 3.1).
- Expected shapes: `redirect()` in a load = one span named after the destination, both loaders under it. Click during a pending navigation = one span, final route's name, first click's `url.path`. `cancel()` = bare `navigate`, ~0 ms. Unknown route = document load, bare `pageload`. Hash links and `pushState` = no span; `invalidate()` reruns = own traces.

## Load functions

Wrap universal loads (`+page.ts`, `+layout.ts`) with this helper:

```ts
// src/lib/trace-load.ts
import { MapleBrowser } from "@maple-dev/browser"
import { isHttpError, isRedirect } from "@sveltejs/kit"

/** Runs a universal load in a `loader <route id>` span under the current navigation. */
export const traceLoad = <T>(routeId: string | null, fn: () => Promise<T>) =>
	MapleBrowser.traced(`loader ${routeId}`, fn, {
		// redirect() and error() below 500 are control flow, not failures
		isFailure: (e) => !isRedirect(e) && !(isHttpError(e) && e.status < 500),
	})
```

```ts
// src/routes/projects/[id]/+page.ts
import { traceLoad } from "#lib/trace-load.js"
import { error } from "@sveltejs/kit"
import type { PageLoad } from "./$types"

export const load: PageLoad = ({ fetch, params, route }) =>
	traceLoad(route.id, async () => {
		const [project, members] = await Promise.all([
			fetch(`/api/projects/${params.id}`),
			fetch(`https://api.acme.com/projects/${params.id}/members`),
		])
		if (project.status === 404) error(404, "Project not found")
		return { project: await project.json(), members: await members.json() }
	})
```

- Import as `#lib/trace-load.js` (TypeScript doesn't resolve `#lib/trace-load`; Vite maps `.js` to the `.ts` file). Kit 2: `$lib/trace-load`.
- Use the `fetch` SvelteKit passes to `load`. Start requests before the first `await` (`Promise.all`); later ones lose the span.
- Don't wrap server loads (`+page.server.ts`): SvelteKit's server tracing spans them; their `__data.json` request is its own trace.
- Expected, don't "fix": first-load loader spans ~0 ms (hydration reads inlined responses); hover preloads (`data-sveltekit-preload-data="hover"`) run loads before the click as their own traces, leaving the `navigate` span childless. Don't change the preload setting.

## Errors

Each recorded once: browser load throw → its `loader` span; browser render throw → `sveltekit.client_error`; event handler throw → `browser.uncaught_error`; SSR load throw → server `sveltekit.load` span. SSR render throw: 500, no span records it (known gap). Don't add a server `handleError` that records errors: it would duplicate the `sveltekit.load` ones.

## Server side

Skip for `adapter-static` / SPA mode: the page load starts its own trace.

1. Add `tracing: { server: true }` to the `sveltekit({ ... })` options in `vite.config.ts`.
2. `npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http` (as `dependencies`).
3. `src/instrumentation.server.ts`, loaded before app code (supported by `adapter-node`; check other adapters' docs). Server code may use the private key from an env var:

```ts
// src/instrumentation.server.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"

new NodeSDK({
	serviceName: "acme-web-server",
	traceExporter: new OTLPTraceExporter({
		url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
		headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
	}),
}).start()
```

If the project already starts an OpenTelemetry SDK, keep it and skip this file.

4. Add `<meta name="traceparent" content="%maple.traceparent%" />` to the `<head>` of `src/app.html`.
5. Fill it in `src/hooks.server.ts`. Existing `handle`: compose with `sequence` from `@sveltejs/kit/hooks`, or merge the `transformPageChunk` into the existing `resolve` call.

```ts
// src/hooks.server.ts
import { context, propagation, trace } from "@opentelemetry/api"
import type { Handle } from "@sveltejs/kit/hooks"

export const handle: Handle = ({ event, resolve }) => {
	// The trace context of SvelteKit's root span for this request
	const carrier: { traceparent?: string } = {}
	propagation.inject(trace.setSpan(context.active(), event.tracing.root), carrier)

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace("%maple.traceparent%", carrier.traceparent ?? ""),
	})
}
```

- No ETag handling needed: SvelteKit hashes the HTML after `transformPageChunk`, so each render has its own `ETag`.
- Without server tracing the placeholder becomes `""` and the page load starts its own trace.
- CDN-cached pages: leave the tag out, or every visitor joins one trace.
- A load's server-side `fetch` to another origin carries no `traceparent` without HTTP instrumentation; same-origin `+server` endpoints join automatically.

## Check

Dev server and `vite build && node build` behave the same. In addition to `SKILL.md` Step 7:

- Load `/projects/1`: the meta tag holds a traceparent; `pageload /projects/[id]` has `parentSpanId` = the server's `sveltekit.handle.root` span, same `traceId`; `loader /projects/[id]` under it. Reload: new `traceId`.
- Click a link with `el.click()` (no hover): `navigate /projects/[id]` → `loader /projects/[id]` → `fetch` spans → server `sveltekit.handle.root` / API server span.
- Redirecting route: one `navigate <destination>` span with `url.path` = the original path.
- Load that throws (client nav): one `exception` event, on the `loader` span; no `sveltekit.client_error` for it.
- Link to a missing route: bare `pageload`, no `exception` events.

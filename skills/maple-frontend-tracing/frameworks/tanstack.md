# TanStack Router and TanStack Start

Tested with `@tanstack/react-router` 1.170, `@tanstack/react-start` 1.169, `@maple-dev/browser` 0.14.0. Human version (full snippets): https://maple.dev/docs/frontend/tanstack

No TanStack SDK entry exists. Use `MapleBrowser` (`@maple-dev/browser`) and `instrumentTanStackRouter` (`@maple-dev/browser/react`). Install `@opentelemetry/api` too.

## Init and caught errors

`src/maple.ts` per SKILL.md Step 2; make `import "./maple"` the first import of `src/router.tsx` (both scaffolds export `getRouter()` there). Add to `createRouter`:

```ts
defaultErrorComponent: ErrorComponent, // from @tanstack/react-router; keep an existing one
defaultOnCatch: (error) => MapleBrowser.captureException(error),
```

- `defaultOnCatch` only runs for routes with an error component. Existing `defaultOnCatch`: add the call inside it. A route's own `onCatch` replaces it: add the call there too.
- Reports once: loader errors already on the `traced` span are skipped; SSR loader errors are reported from the browser after hydration.

## Navigations

Attach `instrumentTanStackRouter` once; don't add `startNavigation`/`endNavigation` calls:

- **Start:** in the root route component (`RootDocument`): `const router = useRouter(); useEffect(() => instrumentTanStackRouter(router), [router])`. Never in `getRouter()`: attached before hydration, the page load never ends and the first click closes it as interrupted.
- **Router without Start:** `src/main.tsx`, right after `const router = getRouter()`, before `render`. A root effect attaches after the first route's loaders ran, which orphans them.

Behaviour: names are the leaf route `fullPath` (`navigate /projects/$projectId`). Search-only changes and hash links: no span. Click while loading, or a client-side `redirect()`: the first span ends unnamed with `maple.navigation.interrupted`, then a span for the target. SSR redirect: `pageload <target>`. Unmatched URL: `pageload /` / `navigate /` (root route). StrictMode/HMR double attach is deduplicated.

## Loaders

```ts
// src/traced-loader.ts
import { MapleBrowser } from "@maple-dev/browser"
import { isNotFound, isRedirect } from "@tanstack/react-router"

// redirect() and notFound() are thrown, but they aren't failures
export const tracedLoader = <T>(name: string, fn: () => Promise<T>) =>
	MapleBrowser.traced(name, fn, { isFailure: (error) => !isRedirect(error) && !isNotFound(error) })
```

Wrap each route `loader` (and `beforeLoad` with I/O): `loader: ({ params }) => tracedLoader("loader <fullPath>", () => Promise.all([...]))`.

- `await` rule (SKILL.md Step 4): `Promise.all`, or `context.active()` before the first `await` and `context.with(ctx, …)` after it.
- Preloaded loaders and server functions called from loaders are their own traces; say so in the hand-off, don't try to fix it.
- On the server `traced` only runs `fn`.

## SSR (TanStack Start)

1. Server OTel per `maple-nodejs-style`, preloaded with `--import` (dev: `NODE_OPTIONS="--import ./tracing.mjs" vite dev`). Drop `import-in-the-middle`'s `register()` for `vite dev`: it fails loading `vite.config.ts` with a TDZ `ReferenceError`; HTTP and undici instrumentation work without it.
2. Create `src/server.ts` (or add the header logic to an existing one's `fetch`):

	```ts
	// src/server.ts
	import { context, propagation } from "@opentelemetry/api"
	import handler, { createServerEntry } from "@tanstack/react-start/server-entry"

	export default createServerEntry({
		async fetch(request) {
			const response = await handler.fetch(request)
			// Hand the server's trace to the browser's pageload span (HTML responses only)
			if (response.headers.get("content-type")?.startsWith("text/html")) {
				const carrier: { traceparent?: string } = {}
				propagation.inject(context.active(), carrier)
				if (carrier.traceparent) response.headers.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
			}
			return response
		},
	})
	```

- `context.active()` is the HTTP instrumentation's request span. If a CDN caches HTML, strip `server-timing` from cached responses.

## Check

In addition to SKILL.md Step 7 (the dev server behaves the same):

- Reload: exactly one `pageload <fullPath>`; with Start its `parentSpanId` is the span id in the document's `server-timing` header, in the trace of the server's fetch spans.
- Click: one `navigate <fullPath>` → `loader …` → `fetch` spans → API spans, one trace.
- Search-only link: no span.
- Loader that throws: one `exception` event by click (on the loader span), one `exception` span when loaded directly in Start.

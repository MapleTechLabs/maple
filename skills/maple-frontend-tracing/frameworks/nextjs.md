# Next.js (App Router)

Written against Next.js 16.3, React 19.3, `@vercel/otel` 2.1, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/nextjs

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/nextjs` (client) and `@maple-dev/browser/nextjs/server` (proxy). No `@opentelemetry/api` needed unless app code imports it.

The server side (`instrumentation.ts` + `@vercel/otel`) is `maple-nextjs-style`. Set it up first if missing; Next.js already creates spans for requests, rendering, route handlers and server `fetch()`. One server option matters here:

```ts
// src/instrumentation.ts (next to instrumentation-client.ts)
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel"

export function register() {
	registerOTel({
		serviceName: "acme-next",
		// `traceExporter` takes an exporter instance in @vercel/otel 2.x, not a `{ url, headers }` object
		traceExporter: new OTLPHttpProtoTraceExporter({
			url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
			headers: { authorization: "Bearer MAPLE_TEST" },
		}),
		instrumentationConfig: {
			// @vercel/otel only sends traceparent to the app's own Vercel URLs by default.
			// List the cross-origin first-party APIs that Server Components and route handlers fetch.
			fetch: { propagateContextUrls: [/^https:\/\/api\.acme\.com\//] },
		},
	})
}
```

Without `propagateContextUrls`, the API's spans behind a Server Component `fetch()` are separate traces. First-party APIs only.

## Init and navigations

`instrumentation-client.ts` (Next.js 15.3+), next to `instrumentation.ts` (in `src/` if the app uses it). Runs before hydration:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "MAPLE_TEST", // public key, maple_pk_…
	serviceName: "acme-web",
	region: "us", // "eu" for EU organizations
	environment: process.env.NODE_ENV,
	tracing: {
		// APIs the browser calls on another origin (SKILL.md Step 3)
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

// Next.js only reports client-side navigations, so the first page load starts here
MapleBrowser.startNavigation(location.pathname)

export { onRouterTransitionStart } from "@maple-dev/browser/nextjs"
```

If the app initializes `@maple-dev/browser` from a client component in the root layout, move the call here: Next.js only calls `onRouterTransitionStart` when this file exports it. If this file already exports an `onRouterTransitionStart`, call the SDK's from it (`import { onRouterTransitionStart as mapleTransitionStart } from "@maple-dev/browser/nextjs"`).

Root `app/layout.tsx`: render `<MapleNavigation />` once, inside `<body>`, **above** `{children}`. It brings its own `<Suspense>`; don't wrap it.

```tsx
import { MapleNavigation } from "@maple-dev/browser/nextjs"
// in <body>:
<MapleNavigation />
{children}
```

Behavior (SDK-verified):

- Names: route template rebuilt from `useParams()` (`navigate /projects/[id]`, `/docs/[...slug]`). Unmatched URL: `/_not-found`. `notFound()` from a matched route keeps that route's template.
- A `<Link>` to an unmatched URL reloads the page: the old document's `navigate` span is exported as interrupted, the new one reports `pageload /_not-found`.
- Hash links and links to the pathname+query on screen start no span; one clicked while a navigation is in flight ends that navigation as interrupted. Query changes are navigations. `router.refresh()` / a revalidating server action doesn't end a navigation in flight.
- `redirect()` during a client navigation gives two spans (`navigate /old`, `navigate /new`).
- Back/forward and `router.push` go through `onRouterTransitionStart`. A route restored from the router cache gives a `navigate` span of a few milliseconds.
- With `loading.tsx`, the span ends when the skeleton commits.
- Strict Mode (`next dev`) runs effects twice; the second end is a no-op.

Known limits (mention if they apply): `basePath` + back/forward to a hash-only history entry can open a span that ends interrupted; a static segment after a param with the same value (`/users/settings/settings` for `/users/[name]/settings`) is ambiguous; `[[...slug]]` can't be told from `[...slug]` (`/docs` is `navigate /docs`); a root-layout error rendering `global-error.tsx` unmounts `MapleNavigation`, so that navigation ends interrupted at the next navigation or page leave.

Pages Router instead (no SDK entry): in `pages/_app.tsx`, `router.events` `routeChangeStart` → `MapleBrowser.startNavigation(<new path>)`, `routeChangeComplete` / `routeChangeError` → `MapleBrowser.endNavigation(router.pathname)` (`router.pathname` is already the template).

## Data loading

- Server Components are the route-level data loading, and Next.js already traces them: the render span (`render route (app) /projects/[id]` on a page load, `RSC GET /projects/[id]` on a client navigation) with the server `fetch()` spans under it. Don't wrap Server Component `fetch()` calls.
- The client navigation's `?_rsc=` request carries `traceparent`, so the server spans join it, but that request is its own trace, not under the `navigate` span (Next makes it internally). Prefetches are separate traces too. Expected; tell the user.
- A `<Link>` in view to an unmatched URL is prefetched, and that 404 `fetch` span is marked Error (OpenTelemetry marks 4xx client spans as errors). No `exception` event, not an app error; mention it if the app links to missing pages.
- Database or SDK calls in Server Components (not `fetch`): wrap with `traced` from `@maple-dev/browser/server`, always with `isFailure: () => false`. Next.js records an error thrown out of a Server Component on its render span, and `redirect()` / `notFound()` throw:

```ts
import { traced } from "@maple-dev/browser/server"

const project = await traced("load project", () => db.project.findUnique({ where: { id } }), {
	isFailure: () => false,
})
```

- Client components (SWR, React Query, effects) run after the navigation span ended: their `fetch` spans are separate traces. Wrapping the query function in `MapleBrowser.traced` only names them; optional.

## Caught errors

In every `error.tsx` and in `global-error.tsx` (client components):

```tsx
import { reportNextError } from "@maple-dev/browser/nextjs"
import { useEffect } from "react"

// in the component
useEffect(() => reportNextError(error), [error])
```

- Reports `react.render_error`. Skips errors with a `digest` (Server Component errors with the message stripped, already recorded on Next's server span) and errors `traced` recorded.
- Don't add `onRequestError` in `instrumentation.ts` when OpenTelemetry is set up: Next already records server errors on its spans, so it would double them.
- A client component that throws on every render fails twice on a full page load: once in the server render (render span, 500) and once in the browser (`error.tsx`, no digest). Two executions of the bug, not a double report; after a client navigation it's only the browser one.

## Link the page load to the server render

Pages can't set response headers. Two options:

1. **`proxy.ts`** (`middleware.ts` before Next 16), verified on `next start`:

```ts
// src/proxy.ts
import { withMapleProxy } from "@maple-dev/browser/nextjs/server"

export const proxy = withMapleProxy()

export const config = {
	matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}
```

- Existing `proxy.ts`/`middleware.ts`: wrap its function, `export const proxy = withMapleProxy(existingProxy)` (or `export const middleware = …`), and keep its matcher. Its responses pass through: only `next()`, a same-origin `rewrite()` or no response get the headers; redirects, own responses and external rewrites are untouched.
- A `traceparent` the request already carries (RSC requests from client navigations) is kept.
- Platforms that start their own server span first, or run the proxy separately (edge), may not join the render; say so in the hand-off.
- Runs on every matched request, including prerendered pages and 304 revalidations, so Next's `ETag` is harmless. Exception: a shared cache (CDN honoring Next's `s-maxage` on prerendered HTML) would store the header and every visitor would join one trace. In that setup, leave prerendered routes out of the matcher or use option 2.

2. **`experimental.clientTraceMetadata: ["traceparent"]`** in `next.config.ts`: Next renders `<meta name="traceparent">` into dynamically rendered pages; the SDK reads it. Experimental. Use it when the proxy doesn't fit.

Static (prerendered) pages have no render to join: with the proxy, their `pageload` joins a trace holding only the proxy span; with `clientTraceMetadata`, they get no `<meta>` and the `pageload` is its own trace.

## Verify (Next.js specifics for SKILL.md Step 7)

Use `next build` + `next start`. Expected traces:

- Page load of a dynamic route: one trace with `middleware GET` (proxy option), `GET /projects/[id]`, the render, server `fetch` spans with the API's spans under them, and `pageload /projects/[id]`. If the API's spans are separate traces, `propagateContextUrls` is missing.
- Click: `navigate /projects/[id]` alone in its trace; a separate `GET …?_rsc=` trace with `RSC GET /projects/[id]` and the server `fetch` spans; client-component `fetch` spans as their own traces.
- Server errors are server-side spans, not in the browser's `/v1/traces` bodies: check the server exporter's output (or Maple) for exactly one `exception` event on the render span per thrown error, and no `react.render_error` from the browser for it.
- `/does-not-exist` gives `pageload /_not-found`, never a span named after the concrete URL.

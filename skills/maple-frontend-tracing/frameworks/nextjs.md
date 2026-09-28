# Next.js (App Router)

Written against Next.js 16.3, React 19.3, `@vercel/otel` 2.1. Human version: https://maple.dev/docs/frontend/nextjs

The server side (`instrumentation.ts` + `@vercel/otel`) is `maple-nextjs-style`. Set it up first if missing; Next.js already creates spans for requests, rendering, route handlers and server `fetch()`. This file is the browser half, plus one server option:

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

Without `propagateContextUrls`, the API's spans behind a Server Component `fetch()` are separate traces. Same rule as the browser: first-party APIs only.

## Init: `instrumentation-client.ts` (Next.js 15.3+)

Next to `instrumentation.ts` (in `src/` if the app uses it). Runs before hydration:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { startNavigation } from "./tracing"

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
startNavigation(location.pathname)

export { onRouterTransitionStart } from "./app/navigation-tracing"
```

If the app already initializes `@maple-dev/browser` from a client component in the root layout, move the call here. Below 15.3, keep the client component and call `startNavigation` there at module scope.

## Navigations

Start: `onRouterTransitionStart(url, navigationType)` (links, `router.push/replace`, back/forward). End: no event; a client component in the root layout ends the span in an effect after commit.

```tsx
// src/app/navigation-tracing.tsx
"use client"

import { useParams, usePathname, useSearchParams, useSelectedLayoutSegments } from "next/navigation"
import { useEffect } from "react"
import { endNavigation, startNavigation } from "../tracing"

// Pathname and query of the route React last committed
let committed: string | undefined
const urlKey = (pathname: string, search: string) => `${pathname}?${new URLSearchParams(search)}`

export function onRouterTransitionStart(url: string) {
	const target = new URL(url, location.href)
	// Hash-only changes and links to the current URL don't render a new route
	if (urlKey(target.pathname, target.search) === committed) return
	startNavigation(target.pathname)
}

export function NavigationTracing() {
	const pathname = usePathname()
	const search = useSearchParams().toString()
	const params = useParams()
	// URLs no route matches render Next.js's built-in `/_not-found` route
	const unmatched = useSelectedLayoutSegments()[0] === "/_not-found"

	useEffect(() => {
		committed = urlKey(pathname, search)
		endNavigation(unmatched ? "/_not-found" : routeTemplate(pathname, params))
	}, [pathname, search, params, unmatched])

	return null
}

/** `/projects/8f2a` with `{ id: "8f2a" }` becomes `/projects/[id]`. */
function routeTemplate(pathname: string, params: ReturnType<typeof useParams>) {
	const segments = pathname.split("/")
	let end = segments.length
	// Params are ordered from the root. Matching from the end keeps a static
	// segment that happens to equal a param value, like in `/projects/projects`.
	for (const [name, value] of Object.entries(params).reverse()) {
		if (!value?.length) continue
		const parts = typeof value === "string" ? [value] : value
		const matchesAt = (at: number) =>
			parts.every((part, i) => segments[at + i] === part || segments[at + i] === encodeURIComponent(part))
		let at = end - parts.length
		while (at > 0 && !matchesAt(at)) at--
		if (at <= 0) continue
		segments.splice(at, parts.length, typeof value === "string" ? `[${name}]` : `[...${name}]`)
		end = at
	}
	return segments.join("/")
}
```

In the root `app/layout.tsx`, render `<Suspense><NavigationTracing /></Suspense>` inside `<body>`, **before** `{children}` (after it, a `redirect()` gets named after the old route). The `Suspense` is required: `useSearchParams()` outside one fails the build for static pages.

- `redirect()` during a client navigation gives two spans (`navigate /old`, `navigate /new`).
- A URL no route matches is named `/_not-found`, never the concrete path (every mistyped URL would be its own span name). A `<Link>` to such a URL makes Next.js reload the page: the `navigate` span is dropped with the old document and the new one reports `pageload /_not-found`. `notFound()` from a matched route keeps that route's template.
- Back/forward and `router.push` go through `onRouterTransitionStart` too. A route restored from the router cache gives a `navigate` span of a few milliseconds.
- With `loading.tsx`, the span ends when the skeleton commits.
- Pages Router instead: `router.events` `routeChangeStart` → `startNavigation`, `routeChangeComplete` / `routeChangeError` → `endNavigation(router.pathname)` (`router.pathname` is already the template), wired in `pages/_app.tsx`.

## Data loading

- Server Components are the route-level data loading, and Next.js already traces them: the render span (`render route (app) /projects/[id]` on a page load, `RSC GET /projects/[id]` on a client navigation) with the server `fetch()` spans under it. Don't wrap Server Component `fetch()` calls.
- The client navigation's `?_rsc=` request carries `traceparent`, so the server spans join it, but that request is its own trace, not under the `navigate` span (Next makes it internally). Prefetches are separate traces too. That's expected; tell the user.
- A `<Link>` in view to a URL no route matches is prefetched, and that 404 `fetch` span is marked Error (OpenTelemetry marks 4xx client spans as errors). It has no `exception` event and isn't an app error; mention it if the app links to missing pages.
- Wrap database or SDK calls in Server Components (not `fetch`) with `traced` to time them. Next.js records an error thrown out of a Server Component on its render span, so the data span must not record it again:

```ts
// src/data-span.ts
import { traced } from "./tracing"

// Next.js records errors thrown from Server Components on its render span, and
// redirect() / notFound() are thrown too: the data span only times the call
export const dataSpan = <T>(name: string, fn: () => Promise<T>) => traced(name, fn, () => false)
```

- Client components (SWR, React Query, effects) run after the navigation span ended: their `fetch` spans are separate traces. Wrapping the query function in `traced` only names them; optional.

## Caught errors

In every `error.tsx` and in `global-error.tsx` (client components), report from an effect and **skip errors with a `digest`**: those are server errors with the message stripped, already recorded on Next's server span.

```tsx
useEffect(() => {
	if (error.digest || alreadyRecorded(error)) return
	MapleBrowser.captureException(error, { name: "react.render_error" })
}, [error])
```

Don't add `onRequestError` in `instrumentation.ts` when OpenTelemetry is set up: Next already records server errors on its spans, so it would double them.

A client component that throws on every render fails twice on a full page load: once during the server render (recorded on Next's render span, 500 response) and again when the browser renders it (reported by `error.tsx`, no digest). They are two executions of the bug, not a double report of one; after a client navigation it's only the browser one.

## Link the page load to the server render

Pages can't set response headers. Two options:

1. **`proxy.ts`** (`middleware.ts` before Next 16), verified on `next start`:

```ts
// src/proxy.ts
import { context, propagation } from "@opentelemetry/api"
import { type NextRequest, NextResponse } from "next/server"

export function proxy(request: NextRequest) {
	const carrier: Record<string, string> = {}
	propagation.inject(context.active(), carrier)

	// Client navigations already carry the browser's traceparent: leave those alone
	if (request.headers.has("traceparent") || !carrier.traceparent) return NextResponse.next()

	const headers = new Headers(request.headers)
	headers.set("traceparent", carrier.traceparent)
	const response = NextResponse.next({ request: { headers } })
	response.headers.set("server-timing", `traceparent;desc="${carrier.traceparent}"`)
	return response
}

export const config = {
	matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}
```

If a `proxy.ts`/`middleware.ts` exists, merge this logic into it and keep its matcher semantics. On platforms that start their own server span first (or run the proxy at the edge separately), the render may not join; say so in the hand-off.

The proxy runs on every matched request, including prerendered pages and 304 revalidations, so each response gets a fresh header and Next's `ETag` is harmless. The exception is a shared cache in front of `next start` (a CDN that honors the `s-maxage` Next sends on prerendered HTML): it would store the header and every visitor would join one trace. In that setup, leave prerendered routes out of the matcher or use option 2.

2. **`experimental.clientTraceMetadata: ["traceparent"]`** in `next.config.ts`: Next renders `<meta name="traceparent">` into dynamically rendered pages; `serverContext()` in `tracing.ts` reads it. Simpler, but experimental. Use it when the proxy option doesn't fit (existing complex middleware, edge runtime).

Static (prerendered) pages have no render to join: with the proxy, their `pageload` joins a trace holding only the proxy span and the static response; with `clientTraceMetadata`, they get no `<meta>` and the `pageload` is its own trace.

## Verify (Next.js specifics for SKILL.md Step 7)

Use `next build` + `next start`. Expected traces:

- Page load of a dynamic route: one trace with `middleware GET` (proxy option), `GET /projects/[id]`, the render, server `fetch` spans with the API's spans under them, and `pageload /projects/[id]`. If the API's spans are separate traces, `propagateContextUrls` is missing.
- Click: `navigate /projects/[id]` alone in its trace; a separate `GET …?_rsc=` trace with `RSC GET /projects/[id]` and the server `fetch` spans; client-component `fetch` spans as their own traces.
- Server errors are server-side spans, not in the browser's `/v1/traces` bodies: check the server exporter's output (or Maple) for exactly one `exception` event on the render span per thrown error, and no `react.render_error` from the browser for it (the digest check).
- `/does-not-exist` gives `pageload /_not-found`, never a span named after the concrete URL.

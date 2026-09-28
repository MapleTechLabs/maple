# Next.js (App Router)

Written against Next.js 16.3, React 19.3, `@vercel/otel` 2.1. Human version: https://maple.dev/docs/frontend/nextjs

The server side (`instrumentation.ts` + `@vercel/otel`) is `maple-nextjs-style`. Set it up first if missing; Next.js already creates spans for requests, rendering, route handlers and server `fetch()`. This file is the browser half.

## Init: `instrumentation-client.ts` (Next.js 15.3+)

Next to `instrumentation.ts` (in `src/` if the app uses it). Runs before hydration:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { startNavigation } from "./tracing"

MapleBrowser.init({
	ingestKey: "MAPLE_TEST", // public key, maple_pk_…
	serviceName: "acme-web",
	environment: process.env.NODE_ENV,
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

import { useParams, usePathname, useSearchParams } from "next/navigation"
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

	useEffect(() => {
		committed = urlKey(pathname, search)
		endNavigation(routeTemplate(pathname, params))
	}, [pathname, search, params])

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
- With `loading.tsx`, the span ends when the skeleton commits.
- Pages Router instead: `router.events` `routeChangeStart` → `startNavigation`, `routeChangeComplete` / `routeChangeError` → `endNavigation(router.pathname)` (`router.pathname` is already the template), wired in `pages/_app.tsx`.

## Data loading

- Server Components: Next.js traces the render and `fetch()`. The client navigation's `?_rsc=` request carries `traceparent`, so the server spans join it, but that request is its own trace, not under the `navigate` span (Next makes it internally). Prefetches are separate traces too. That's expected; tell the user.
- Wrap database or SDK calls in Server Components (not `fetch`) with `traced`, excluding Next's control-flow throws:

```ts
// src/data-span.ts
import { unstable_rethrow } from "next/navigation"
import { traced } from "./tracing"

// redirect(), notFound() and Next.js's own rendering signals are thrown, but aren't failures
const isFailure = (error: unknown) => {
	try {
		unstable_rethrow(error)
		return true
	} catch {
		return false
	}
}

export const dataSpan = <T>(name: string, fn: () => Promise<T>) => traced(name, fn, isFailure)
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

2. **`experimental.clientTraceMetadata: ["traceparent"]`** in `next.config.ts`: Next renders `<meta name="traceparent">` into dynamically rendered pages; `serverContext()` in `tracing.ts` reads it. Simpler, but experimental. Use it when the proxy option doesn't fit (existing complex middleware, edge runtime).

Static (prerendered) pages have no render to join either way.

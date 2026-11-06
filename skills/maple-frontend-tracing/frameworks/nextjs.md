# Next.js (App Router)

Tested with Next.js 16.4 (Cache Components on and off), React 19.3, `@vercel/otel` 2.3, `@maple-dev/browser` 0.14. Needs Next.js 15.3+ (`instrumentation-client.ts`). Human version: https://maple.dev/docs/frontend/nextjs

There is no Next.js entry in the SDK. Wire `@maple-dev/browser` core calls (`startNavigation`, `endNavigation`, `traced`, `captureException`) to Next's hooks with the files below. Pages Router: not covered here; use `frameworks/other.md` with `router.events`.

## Install

```bash
npm install @maple-dev/browser @vercel/otel
```

Server tracing (`instrumentation.ts` + `@vercel/otel`) is `maple-nextjs-style`; set it up first if missing. `@vercel/otel` 2.x (OTel JS 2.x) next to the SDK (OTel JS 3.x) makes npm resolve `@opentelemetry/api` to 1.9 and the build fails with `Export logs doesn't exist in target module`. Pin it, then reinstall:

```json
{ "overrides": { "@opentelemetry/api": "^1.10.0" } }
```

Verified with npm only (other package managers: their own override field, if they hit it). Check with `npm ls @opentelemetry/api` (one version, 1.10.x).

## Init and navigations

`src/instrumentation-client.ts` (next to `instrumentation.ts`; no `src/` → project root):

```ts
import { MapleBrowser } from "@maple-dev/browser"
import { startNavigation } from "./maple-navigation"

MapleBrowser.init({
	ingestKey: process.env.NEXT_PUBLIC_MAPLE_INGEST_KEY, // public key, maple_pk_…
	serviceName: "acme-web",
	region: "us", // "eu" for EU organizations
	environment: process.env.NODE_ENV,
	tracing: {
		// cross-origin APIs the browser calls (SKILL.md Step 3); RegExp, not string
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

// Next.js reports client-side navigations only, so the page load starts here
startNavigation(location.pathname)

export { onRouterTransitionStart } from "./maple-navigation"
```

- If the app calls `MapleBrowser.init` from a client component in the root layout, move it here and delete the old one.
- If this file already exports `onRouterTransitionStart`, call ours from it instead of re-exporting.
- `NEXT_PUBLIC_*` is inlined at build time: the key must be set where the app builds.

Create `src/maple-navigation.tsx` verbatim:

```tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"
import { useParams, usePathname, useSelectedLayoutSegment } from "next/navigation"
import { useEffect } from "react"

/** The pathname the navigation in flight is going to. */
let pending: string | undefined

export function startNavigation(path: string) {
	pending = path
	MapleBrowser.startNavigation(path)
}

/** Next.js calls this from instrumentation-client.ts for every client-side navigation. */
export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse") {
	const path = new URL(url, location.href).pathname
	if (path === pending) return // already on its way there
	// A query or hash change is not a navigation. Back and forward have already updated location.
	if (pending === undefined && navigationType !== "traverse" && path === location.pathname) return
	startNavigation(path)
}

/** `/projects/8f2a` → `/projects/[id]`: Next.js doesn't expose the matched route in the browser. */
function routeTemplate(pathname: string, params: Record<string, string | string[] | undefined>): string {
	const segments = pathname.split("/")
	for (const [name, value] of Object.entries(params)) {
		if (value === undefined) continue
		const parts = Array.isArray(value) ? value : [value]
		const at = segments.findLastIndex((_, i) => parts.every((part, j) => segments[i + j] === part))
		if (at > 0) segments.splice(at, parts.length, Array.isArray(value) ? `[...${name}]` : `[${name}]`)
	}
	return segments.join("/")
}

/** Ends the navigation once its route has committed. Render it in the root layout, after `{children}`. */
export function MapleNavigation() {
	const pathname = usePathname()
	const params = useParams()
	// A URL that matches no route renders the root not-found.tsx
	const notFound = useSelectedLayoutSegment() === "/_not-found"
	useEffect(() => {
		// A redirect commits the old URL first: wait for the one the navigation is going to
		if (pending !== location.pathname) return
		pending = undefined
		MapleBrowser.endNavigation(notFound ? "/_not-found" : routeTemplate(pathname, params))
	}, [pathname, params, notFound])
	return null
}
```

`findLastIndex` needs `"lib": ["esnext"]` (Next's default tsconfig has it). Root `app/layout.tsx`: render it once in `<body>`, after `{children}`, inside `<Suspense>` (required with Cache Components: `usePathname()` outside Suspense fails the render; harmless without):

```tsx
import { Suspense } from "react"
import { MapleNavigation } from "@/maple-navigation"
// in <body>:
{children}
<Suspense>
	<MapleNavigation />
</Suspense>
```

Behavior (verified):

- `pageload /projects/[id]` then `navigate /projects/[id]`; concrete path in `url.path`. Catch-all → `[...slug]`; percent-encoded params resolve.
- Query and hash changes: no span. Back/forward: `navigate`.
- Navigation started before the previous ended: previous gets `maple.navigation.interrupted`.
- Span ends at the commit: with `<Suspense>`/`loading.tsx`, when the fallback shows.
- `redirect()` in a client navigation: unnamed interrupted `navigate` (url.path = old path), then `navigate <target template>`. On a page load it's an HTTP redirect: one `pageload` for the target.
- Unmatched URL: `/_not-found`. A `<Link>` to one reloads the document: interrupted `navigate`, then `pageload /_not-found`. `notFound()` in a matched route keeps that route's template.
- Known limits (mention if they apply): a static segment equal to a param value (`/users/settings/settings` for `/users/[name]/settings`) can be misnamed; `[[...slug]]` is named `[...slug]`; `basePath` untested.

## Data loading

- Server Components: Next traces them (render span + server `fetch` spans). Don't wrap them with browser `traced`.
- Client navigation's `GET …?_rsc=` fetch is its own trace with `RSC GET /route` under it, not under `navigate`. Prefetches are separate traces; a prefetched link to a missing page is a 404 `fetch` span marked Error. Expected; tell the user.
- Client-component fetches: optionally wrap in `MapleBrowser.traced("load members", () => fetch(...).then(...))` to name the trace. It nests under the navigation only if it starts before the navigation ends (often not). Requests after the first `await` inside `traced` lose the parent; use `Promise.all`.
- Cross-origin APIs called from Server Components: add `instrumentationConfig: { fetch: { propagateContextUrls: [/^https:\/\/api\.acme\.com\//] } }` to `registerOTel` (`@vercel/otel` only propagates to the deployment's own URLs).

## Caught errors

Every `error.tsx` and `global-error.tsx` (client components):

```tsx
import { MapleBrowser } from "@maple-dev/browser"
import { useEffect } from "react"

// in the component, error: Error & { digest?: string }
useEffect(() => {
	// A digest means a Server Component threw: Next.js already recorded it on its server span
	if (!error.digest) MapleBrowser.captureException(error)
}, [error])
```

- Server Component errors carry a `digest` and are recorded on Next's server span (`render route (app) /route` or `RSC GET /route`); skipping them avoids a second issue for the same error.
- `captureException` dedupes by error object: an error the global handler already caught (root layout error in `next dev`) is not recorded twice.
- A client component that throws on a full page load fails on the server render span and in the browser: two executions, not a double report.
- `global-error.tsx` unmounts `MapleNavigation`: that navigation ends interrupted.

## Link the page load to the server render

`next.config.ts`, merged into the existing config:

```ts
experimental: {
	clientTraceMetadata: ["traceparent"],
},
```

Next renders `<meta name="traceparent">` from the request's server span into dynamic and partially prerendered pages; the SDK reads it. Static (prerendered) pages get no tag: their `pageload` is its own trace. Experimental option; needs server OTel (`registerOTel`) running.

## Verify (Next.js specifics for SKILL.md Step 7)

`next build` + `next start` (dev runs effects twice under Strict Mode and renders every page dynamically):

- Dynamic route page load: one trace, `GET /projects/[id]` root → render + server `fetch` spans (+ API spans with `propagateContextUrls`), and `pageload /projects/[id]` with parent = the `GET` span id, children `documentFetch`/`domProcessing`.
- Static page load: `pageload /` with no parent.
- Click: `navigate /projects/[id]`, root of its own trace; separate `GET …?_rsc=` trace with `RSC GET /projects/[id]`.
- `/does-not-exist`: `pageload /_not-found`, never a span named after the concrete URL.
- Client component throw after a click: exactly one browser span with an `exception` event. Server Component throw: zero browser exception spans, one `exception` on the server span.
- If the build fails with `Export logs doesn't exist`, the `@opentelemetry/api` override is missing.

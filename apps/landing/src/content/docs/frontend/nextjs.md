---
title: "Frontend tracing for Next.js"
description: "Trace App Router navigations and error boundaries in the browser with @maple-dev/browser, and join the first page load to the Next.js server render in one OpenTelemetry trace."
group: "Frontend"
order: 3
navLabel: "Next.js"
icon: "nextjs"
---

This page sets up `@maple-dev/browser` in a Next.js App Router app: a span for every page load and navigation, named after the route template (`navigate /projects/[id]`), errors from `error.tsx` and `global-error.tsx`, and a first page load that joins the server render's trace.

It needs Next.js 15.3 or later, for `instrumentation-client.ts`. The examples use a `src/` directory and were tested with Next.js 16.4, `@vercel/otel` 2.3 and `@maple-dev/browser` 0.14.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step on this page.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Next.js.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

## Install

```bash
npm install @maple-dev/browser @vercel/otel
```

`@vercel/otel` traces the server, which the page load joins. It's built on OpenTelemetry JS 2.x and the browser SDK on 3.x, and npm then resolves `@opentelemetry/api` to 1.9, which fails the build with `Export logs doesn't exist in target module`. Pin it in `package.json` and run `npm install` again:

```json
{
	"overrides": { "@opentelemetry/api": "^1.10.0" }
}
```

## Initialize the SDK

`instrumentation-client.ts` runs after the HTML loads and before React hydrates. Put it next to `instrumentation.ts`:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { startNavigation } from "./maple-navigation"

MapleBrowser.init({
	ingestKey: process.env.NEXT_PUBLIC_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: process.env.NODE_ENV,
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

// Next.js reports client-side navigations only, so the page load starts here
startNavigation(location.pathname)

export { onRouterTransitionStart } from "./maple-navigation"
```

- Use the public `maple_pk_` key from **Settings → Ingestion**. Next.js inlines `NEXT_PUBLIC_*` variables at build time, so set it where you build. EU organizations add `region: "eu"`.
- `init()` traces `fetch` and `XMLHttpRequest`, records uncaught errors, Web Vitals and session replay. The [Browser SDK reference](/docs/session-replay/browser-sdk) lists every option.
- Same-origin requests (route handlers, Server Component payloads) always carry `traceparent`. `propagateTraceHeaderCorsUrls` adds APIs on other origins. Each must allow `traceparent` in `Access-Control-Allow-Headers`, or the browser blocks the request. List only your own APIs.

## Trace navigations

Next.js reports when a client navigation starts, through `onRouterTransitionStart`, but not when it ends or which route it matched. This file starts the span there, and ends it from a component once the new route has committed, with the route template rebuilt from `useParams()`:

```tsx
// src/maple-navigation.tsx
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

Render `MapleNavigation` once in the root layout. It needs a `<Suspense>` boundary: with Cache Components on, reading the pathname outside one fails the render.

```tsx
// src/app/layout.tsx
import { Suspense } from "react"
import { MapleNavigation } from "@/maple-navigation"

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>
				{children}
				<Suspense>
					<MapleNavigation />
				</Suspense>
			</body>
		</html>
	)
}
```

What the spans look like:

- The first route is `pageload /projects/[id]`, every later one `navigate /projects/[id]`, with the concrete path in `url.path`. Catch-all routes are named `[...slug]`.
- Query and hash changes start no span. Back and forward are navigations.
- A navigation started before the previous one ended ends that one with `maple.navigation.interrupted`.
- The span ends when the new route commits. On a route with a `<Suspense>` boundary or `loading.tsx`, that's when the fallback shows, not when the streamed content arrives.
- `redirect()` during a client navigation gives an unnamed `navigate` span for the old path, ended as interrupted, then `navigate /new-route`. A redirect on a page load is an HTTP redirect, so there's one `pageload` for the target.
- A URL that matches no route is `/_not-found`. A `<Link>` to one makes Next.js reload the page: the `navigate` span ends as interrupted, and the new document reports `pageload /_not-found`. `notFound()` in a matched route keeps that route's template.
- Templates are rebuilt from param values, so a static segment with the same value as a param, like `/users/settings/settings` for `/users/[name]/settings`, can be named wrong. An optional catch-all `[[...slug]]` is named `[...slug]`.

## Data loading

Server Components load data on the server, where Next.js traces it. On a client navigation, the router fetches the route's payload as `GET /projects/abc?_rsc=…`. That `fetch` span is its own trace, with Next.js's `RSC GET /projects/[id]` server span under it, not under the `navigate` span: Next.js starts the request inside its router. Prefetches are separate traces too, and a prefetched link to a missing page is a failed `fetch` span (404).

For data loaded in client components, wrap the request in `MapleBrowser.traced` to give its trace a name:

```tsx
// src/app/projects/[id]/members.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"
import { useEffect, useState } from "react"

export function Members({ projectId }: { projectId: string }) {
	const [members, setMembers] = useState<string[]>([])

	useEffect(() => {
		MapleBrowser.traced("load members", () =>
			fetch(`https://api.acme.com/projects/${projectId}/members`).then((res) => res.json()),
		).then(setMembers)
	}, [projectId])

	return <ul>{members.map((name) => <li key={name}>{name}</li>)}</ul>
}
```

- The `fetch` span nests under `load members`, and the API's server span under the `fetch` span.
- `traced` nests under the navigation only if it starts before the navigation ends. That depends on when the component hydrates or streams in, so `load members` is often its own trace.
- Only requests started before the first `await` inside `traced` nest under it: the browser has no async context. Start independent requests together with `Promise.all`.

## Report errors

Each `error.tsx` is a React error boundary, so the errors it catches never reach the SDK's global handlers. Report them from an effect:

```tsx
// src/app/error.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"
import { useEffect } from "react"

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
		// A digest means a Server Component threw: Next.js already recorded it on its server span
		if (!error.digest) MapleBrowser.captureException(error)
	}, [error])

	return (
		<main>
			<h2>Something went wrong</h2>
			<button onClick={reset}>Try again</button>
		</main>
	)
}
```

Add the same effect to `global-error.tsx`, which replaces the whole document when the root layout throws.

- A Server Component error reaches the browser with a `digest`. Next.js records the original exception on its server span (`render route (app) /route` on a page load, `RSC GET /route` on a client navigation), so the browser skips it.
- Each error is recorded once. `captureException` skips an error object the SDK already recorded, such as a root layout error the global handler caught in `next dev`.
- A client component that throws on a full page load fails twice: on the server render span, and in the browser. Those are two executions of the bug. After a client navigation, only the browser one happens.
- `global-error.tsx` unmounts `MapleNavigation`, so the navigation that hit the error ends as interrupted.

## Join the page load to the server render

The `pageload` span joins the server's trace when the page carries a `<meta name="traceparent">` tag. Next.js renders one with its experimental `clientTraceMetadata` option, from the trace that `instrumentation.ts` sets up:

```ts
// src/instrumentation.ts
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel"

export function register() {
	registerOTel({
		serviceName: "acme-next",
		traceExporter: new OTLPHttpProtoTraceExporter({
			url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
			headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
		}),
		instrumentationConfig: {
			// Server-side fetch() only sends traceparent to these origins
			fetch: { propagateContextUrls: [/^https:\/\/api\.acme\.com\//] },
		},
	})
}
```

```ts
// next.config.ts, in the config object
experimental: {
	clientTraceMetadata: ["traceparent"],
},
```

- A page load of a dynamic or partially prerendered route is one trace: `GET /projects/[id]` at the root, the render and its `fetch` spans (with your API's spans under them), and `pageload /projects/[id]` with its `documentFetch` and `domProcessing` children.
- Static (prerendered) pages get no tag, so their `pageload` starts its own trace. `next dev` renders every page on request, so there every page load joins.
- `propagateContextUrls` lists your APIs on other origins: `@vercel/otel` only propagates to the deployment's own URLs by default.

## Verify

Run `next build` and `next start`, then check in **Traces**:

1. Load a dynamic route: one trace with `GET /projects/[id]` and `pageload /projects/[id]` under it.
2. Click a link: `navigate /projects/[id]` in its own trace, never a span named after the concrete URL.
3. Open `/does-not-exist`: `pageload /_not-found`.
4. Throw in a client component: one error on the **Errors** page.

In `next dev`, Strict Mode runs effects twice, so `traced` calls from effects show up twice.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): sampling, consent, masking, logs and URL redaction.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

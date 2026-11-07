---
title: "Frontend tracing for TanStack Router and TanStack Start"
description: "Trace TanStack Router navigations and loaders as OpenTelemetry traces linked to your backend, report route errors, and join TanStack Start's server render to the browser page load."
group: "Frontend"
order: 1
navLabel: "TanStack"
icon: "tanstack"
---

This page connects a TanStack Router app to Maple with `@maple-dev/browser`: a span per navigation named after the route's full path, a span per loader with its `fetch` calls and your backend's spans under it, and route errors reported once. With TanStack Start, the browser's page load joins the server render's trace.

Tested with `@tanstack/react-router` 1.170, `@tanstack/react-start` 1.169 and `@maple-dev/browser` 0.14.0.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses TanStack Router (and TanStack Start, if it renders on the server).

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install and initialize

```bash
npm install @maple-dev/browser @opentelemetry/api
```

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
	tracing: {
		// APIs on another origin that should receive `traceparent`
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Import it first in `src/router.tsx`, which both the Start and the Router scaffolds have. The same file reports errors that route error boundaries catch:

```tsx
// src/router.tsx
import "./maple" // first: init() runs before the router exists (a no-op on the server)
import { MapleBrowser } from "@maple-dev/browser"
import { createRouter, ErrorComponent } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
	return createRouter({
		routeTree,
		// ...your existing options
		defaultErrorComponent: ErrorComponent, // defaultOnCatch only runs where a route has an error component
		// Errors the route error boundaries catch never reach window.onerror
		defaultOnCatch: (error) => MapleBrowser.captureException(error),
	})
}
```

For an EU organization, add `region: "eu"`. Every other option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your API

Same-origin requests, including Start server functions, carry a `traceparent` header, so the backend's span joins the browser's trace. For an API on another origin, list it in `propagateTraceHeaderCorsUrls` and allow the header in its CORS preflight, or the browser blocks the request:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent
```

List only your own APIs. The backend reads the header through its OpenTelemetry HTTP instrumentation ([Instrument your application](/docs/instrumentation)).

## Trace navigations

`instrumentTanStackRouter` from `@maple-dev/browser/react` opens a span when the router starts a navigation and ends it when the route resolves.

**TanStack Start:** call it in an effect in the root route's component (`RootDocument` in the scaffold), so it attaches after hydration. Attached in `getRouter()`, the page load never ends and the first click closes it as interrupted.

```tsx
// src/routes/__root.tsx
import { instrumentTanStackRouter } from "@maple-dev/browser/react"
import { useRouter } from "@tanstack/react-router"
import { useEffect } from "react"

function RootDocument({ children }: { children: React.ReactNode }) {
	const router = useRouter()
	// One pageload/navigate span per route change; returns the unsubscribe
	useEffect(() => instrumentTanStackRouter(router), [router])
	// ...the rest of your root component
}
```

**TanStack Router without Start:** call it in `src/main.tsx` right after creating the router, before rendering:

```tsx
const router = getRouter()
instrumentTanStackRouter(router) // before the first render, so the first route's loaders nest under the page load
```

What you get:

- Spans are named after the leaf route's `fullPath`: `pageload /projects/$projectId`, then `navigate /projects/$projectId`. The concrete path is in `url.path`.
- Search-only changes (`?tab=members`) and hash links start no span.
- A click before the previous navigation resolves ends that span unnamed (`navigate`) with `maple.navigation.interrupted: true`.
- A `redirect()` during a client navigation does the same: an interrupted span with the original `url.path`, then one for the target route. On a first page load, Start's server sends the redirect, and the page load is named after the target.
- A loader that throws `notFound()` keeps its route's name. A URL no route matches is named after the root route (`navigate /`); use `url.path` to find those.
- StrictMode and HMR attach twice; the second attach reuses the first.

## Trace loaders

Wrap each `loader`, and any `beforeLoad` that does I/O, in `MapleBrowser.traced`, so it gets a span under the navigation with its requests under it. `redirect()` and `notFound()` are thrown, so mark them as not failures:

```ts
// src/traced-loader.ts
import { MapleBrowser } from "@maple-dev/browser"
import { isNotFound, isRedirect } from "@tanstack/react-router"

// redirect() and notFound() are thrown, but they aren't failures
export const tracedLoader = <T>(name: string, fn: () => Promise<T>) =>
	MapleBrowser.traced(name, fn, { isFailure: (error) => !isRedirect(error) && !isNotFound(error) })
```

```ts
// src/routes/projects.$projectId.tsx
export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) =>
		tracedLoader("loader /projects/$projectId", () =>
			Promise.all([fetchProject(params.projectId), fetchMembers(params.projectId)]),
		),
	component: Project,
})
```

The browser has no async context: only requests started before the first `await` in `fn` nest under the loader span. Start independent requests together with `Promise.all`; for a request that needs an earlier result, carry the context across the `await`:

```ts
import { context } from "@opentelemetry/api"

loader: ({ params }) =>
	tracedLoader("loader /seq/$id", async () => {
		const ctx = context.active() // before the first await
		const project = await fetchProject(params.id)
		const members = await context.with(ctx, () => fetchMembers(project.id))
		return { project, members }
	}),
```

- **Preloads** (`defaultPreload: "intent"`) run the loader before the click, so its span is a trace of its own and the `navigate` span has no loader span.
- **Server functions** send their request after an internal `await`, so a call from a loader is its own trace (browser `fetch` span plus the server's spans), not nested under the loader.
- **On the server**, `traced` only runs `fn`. A Start page load's loader time is in the server's request span and its HTTP client spans.

## Report route errors

With `defaultOnCatch` from `src/router.tsx`, each caught error is reported once:

- A loader that throws records the error on its `loader …` span; `captureException` skips it after that.
- A component that throws during render becomes one `exception` span.
- A loader that fails during a Start server render is reported from the browser as one `exception` span when the page hydrates.

A route's own `onCatch` replaces `defaultOnCatch`; call `MapleBrowser.captureException(error)` there too. Errors thrown in event handlers are recorded by the SDK's global handler as `browser.uncaught_error`.

## Join the server render (TanStack Start)

The page load joins the server's trace when the HTML response has a `Server-Timing: traceparent;desc="…"` entry. The server has to be instrumented with OpenTelemetry and write it.

1. Start the OpenTelemetry Node SDK from the [Node.js guide](/docs/guides/instrumentation-nodejs), preloaded with `--import` in front of your server. Its HTTP instrumentation opens a span per request, with the server-side loader fetches under it. In development:

	```bash
	NODE_OPTIONS="--import ./tracing.mjs" vite dev
	```

	Leave out the guide's `import-in-the-middle` `register()` call under `vite dev`: it breaks loading the Vite config, and the HTTP and undici instrumentations don't need it.

2. Write the active trace into HTML responses from a custom server entry:

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

The `pageload` span becomes a child of the server's request span, in one trace with the server's fetches and your API's spans. Later navigations start their own traces. If a CDN caches your HTML, strip the header from cached responses, or every visitor's page load joins the same trace.

## Verify

In **Traces**, filtered to your `serviceName`:

- A reload gives one `pageload <fullPath>` span; with Start, under the server's request span.
- A click gives one `navigate <fullPath>` span, with the `loader …` span, its `fetch` spans and your API's spans under it.

## Next steps

- [Browser SDK reference](/docs/session-replay/browser-sdk): logs, Web Vitals, sampling, privacy and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.

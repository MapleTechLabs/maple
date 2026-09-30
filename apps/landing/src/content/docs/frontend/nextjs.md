---
title: "Frontend tracing for Next.js"
description: "Trace App Router navigations, client data fetching and error boundaries in the browser, and join the first page load to the Next.js server render in one OpenTelemetry trace."
group: "Frontend"
order: 3
navLabel: "Next.js"
icon: "nextjs"
---

Next.js already traces its server: with `@vercel/otel` in `instrumentation.ts`, every request gets spans for the render and every server-side `fetch()`. What it can't see is the browser: how long a click took to show the new page, which requests client components made, and which errors your error boundaries caught. This guide adds that half. The first page load becomes one trace from the incoming request to the page hydrating, and every later click gets a `navigate` span named after the route, like `navigate /projects/[id]`.

Set up the server side first with the [Next.js instrumentation guide](/docs/guides/instrumentation-nextjs). The examples use the App Router, a `src/` directory, and Next.js 16.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Next.js.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser
```

This guide needs `@maple-dev/browser` 0.10.0 or later.

Next.js has a file for this. `instrumentation-client.ts` runs after the HTML loads and before React hydrates, so the SDK is running before any of your components do. It's available from Next.js 15.3, and it goes next to `instrumentation.ts`:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: process.env.NEXT_PUBLIC_MAPLE_INGEST_KEY!, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: process.env.NODE_ENV,
})

// Next.js only reports client-side navigations, so the first page load starts here
MapleBrowser.startNavigation(location.pathname)

export { onRouterTransitionStart } from "@maple-dev/browser/nextjs"
```

Next.js inlines `NEXT_PUBLIC_*` variables at build time, so set the key where you build, not only where you run. It has to be the public `maple_pk_` key, never the private one.

The `startNavigation` call opens the `pageload` span. It starts when this file runs, after the HTML and its JavaScript have downloaded, so it covers hydration but not the time to first byte. The server's half of the trace covers that part, once the two are linked (the last section below). The re-exported `onRouterTransitionStart` starts a span for every navigation after it.

If you followed the [Browser SDK docs](/docs/session-replay/browser-sdk#nextjs), which initialize from a client component in the root layout, move the `init()` call here. Next.js only calls `onRouterTransitionStart` when this file exports it.

`init()` sets up:

- a span for every `fetch()` call;
- error spans for uncaught errors and unhandled promise rejections, which show up on the [Errors](/docs/errors/overview) page;
- session replay, with the same `session.id` on every span and replay event, so a trace links to the recording of the session that produced it;
- export every 2 seconds, plus a flush when the tab is hidden or closed, so the spans from the last moments of a visit aren't lost;
- redaction of credential-looking query parameters (`token`, `code`, `password` and similar) in every URL it sends.

Use the public ingest key (`maple_pk_…`) from **Settings → Ingestion**. It can only write telemetry, so it's safe in browser code. For an EU organization, add `region: "eu"`. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your backend

Each `fetch()` span sends a W3C `traceparent` header, and your backend's span joins the same trace. For requests to the page's own origin this happens automatically. For an API on another origin, list it:

```ts
MapleBrowser.init({
	// ...
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Then allow the header in the API's CORS configuration. Without it, the browser blocks the request after the preflight:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent, tracestate
```

Only list your own APIs. Sending `traceparent` to third parties leaks your trace ids, and many of them reject the preflight.

Your backend needs OpenTelemetry to read the header; every OpenTelemetry HTTP server instrumentation does. See [Instrument your application](/docs/instrumentation) for your backend's language or framework.

Browser and server clocks disagree, so a server span can appear to start slightly before the `fetch` that caused it, and a laptop that slept can be minutes off. Durations are accurate; the offsets between browser and server spans are approximate.

## Navigation and data-loading spans

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The SDK fixes that with a span per navigation, and the data-loading and `fetch` spans nested under it. Three calls do the work:

- `MapleBrowser.startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `MapleBrowser.endNavigation(route)` names the span after the route template and ends it.
- `MapleBrowser.traced(name, fn, { isFailure })` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`. An error it recorded isn't reported a second time by `captureException` or the SDK's global error handlers.

The Next.js integration below connects them to the App Router.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

The first page load joins the server render's trace without any browser code: when the server sends its trace context in a `Server-Timing` header or a `<meta name="traceparent">` tag, the `pageload` span becomes part of that trace, and follows its sampling decision: a page load under a trace the server didn't sample isn't recorded. In a client-only app, it starts a trace of its own. The [Browser SDK reference](/docs/session-replay/browser-sdk#navigation-and-data-loading-spans) has the details.

### The await problem

In the browser, a span only stays active until the first `await` inside it. A request that starts after an `await` loses its parent and shows up as a separate trace.

```ts
// ❌ fetchMembers starts after an await, so it becomes its own trace
MapleBrowser.traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id)
	return { project, members }
})
```

```ts
// ✅ Save the context before the first await, and run later requests inside it
import { context } from "@opentelemetry/api"

MapleBrowser.traced("load project", async () => {
	const ctx = context.active()
	const project = await fetchProject(id)
	const members = await context.with(ctx, () => fetchMembers(project.id))
	return { project, members }
})
```

`context` comes from `@opentelemetry/api`, so add it with `npm install @opentelemetry/api` if you use this pattern. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

If the requests don't depend on each other, start them together with `Promise.all` instead. Both nest under the span, and the page stops waiting on one request before starting the next.

This happens because browsers have no equivalent of Node's `AsyncLocalStorage`, which is what carries the active span across `await` on the server.

## Trace App Router navigations

The App Router reports when a navigation starts, through the `onRouterTransitionStart` export above, but not when it ends. That comes from React: `MapleNavigation` is a client component that ends the span in an effect, which runs once the new route is committed. Render it once in the root layout, above `{children}`:

```tsx
// src/app/layout.tsx
import { MapleNavigation } from "@maple-dev/browser/nextjs"

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>
				<MapleNavigation />
				{children}
			</body>
		</html>
	)
}
```

`MapleNavigation` brings its own `<Suspense>` boundary, which Next.js requires on statically rendered pages because the component reads `useSearchParams()`. What to expect:

- **Spans are named after the route template, rebuilt from the params.** Next.js doesn't expose the matched route pattern on the client, so each value from `useParams()` is replaced with its name. `/projects/8f2a` becomes `navigate /projects/[id]`, and the catch-all `/docs/a/b` becomes `navigate /docs/[...slug]`.
- **Hash links start no span.** Neither does a link to the pathname and query already on screen. If such a link is clicked while another navigation is still loading, that navigation ends as interrupted.
- **Query changes are navigations.** Going from `?tab=1` to `?tab=2` makes Next.js fetch new Server Component data, so it gets a span. `router.refresh()` and a server action that revalidates the page don't end a navigation that's still loading.
- **Unmatched URLs are named `/_not-found`.** A URL that no route matches has no params to replace, so without this every mistyped URL would become its own span name. A `<Link>` to such a URL makes Next.js reload the page: the old document's `navigate` span is exported as interrupted, and the new document reports `pageload /_not-found`. A route that calls `notFound()` keeps its own template, like `navigate /projects/[id]`.
- **Redirects produce two spans.** When a Server Component calls `redirect()` during a client navigation, Next.js renders the redirect first and then starts a second navigation. You'll see `navigate /old` followed by `navigate /new`.
- **The span ends at the commit, not when all data has arrived.** If the route has a `loading.tsx`, the loading state is committed first, and the span ends when the skeleton appears. Content that streams into Suspense boundaries afterwards isn't part of it.

## Trace data loading in Server Components

In the App Router, most data loading happens in Server Components, so it's server-side tracing, and Next.js does most of it for you. On a client navigation, the router fetches the new route's Server Component payload from the same URL with an `_rsc` query parameter. The browser SDK instruments that `fetch` and sends `traceparent` with it, because it's same-origin. On the server, Next.js continues that trace with an `RSC GET /projects/[id]` span, the render, and every `fetch()` your components make.

That request doesn't nest under the `navigate` span. Next.js makes it from inside its router, where your code can't wrap it, and without async context in the browser the navigation span can't reach it on its own. So a click gives you two traces that overlap in time and share a session id: the `navigate` span for what the user waited for, and the `GET ...?_rsc=` trace with the server work behind it.

Three more things to expect in the trace list:

- **Prefetches are traced too.** `<Link>` prefetches routes as they scroll into view, and each prefetch is its own `GET ...?_rsc=` trace. That's real work your server did, just before the click.
- **A link to a missing page gives a failed span.** Its prefetch returns 404, and OpenTelemetry marks client spans with a 4xx status as errors. The span has no exception and nothing in your app failed.
- **Some navigations take a few milliseconds.** A navigation to a prefetched static route often makes no request at all. That's the prefetch working.

### Propagate to your APIs from the server

When a Server Component calls an API on another origin, Next.js's `fetch` span only sends `traceparent` if `@vercel/otel` is told to. By default it propagates to your own Vercel deployment URLs and nothing else, so your API's spans end up in separate traces. List your first-party APIs in `instrumentation.ts`:

```ts
// src/instrumentation.ts
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel"

export function register() {
	registerOTel({
		serviceName: "acme-next",
		traceExporter: new OTLPHttpProtoTraceExporter({
			url: "https://ingest.maple.dev/v1/traces",
			headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
		}),
		instrumentationConfig: {
			fetch: { propagateContextUrls: [/^https:\/\/api\.acme\.com\//] },
		},
	})
}
```

The same rule as in the browser applies: only your own APIs, never third parties.

### Database and SDK calls

Next.js's spans cover the render and `fetch()`, but not database queries or SDK calls. Wrap those with `traced` from `@maple-dev/browser/server` to time them. It creates the span with the OpenTelemetry setup from `instrumentation.ts`, under the active span, which is Next.js's render span. Node has `AsyncLocalStorage`, so requests after an `await` keep their parent too.

When a Server Component throws, Next.js records the exception on its render span and marks it as an error. If the data span recorded the same error, it would count twice, so pass an `isFailure` that always returns `false`. That also keeps `redirect()` and `notFound()`, which work by throwing, from showing up as failures:

```tsx
// src/app/projects/[id]/page.tsx
import { traced } from "@maple-dev/browser/server"
import { notFound } from "next/navigation"
import { db } from "../../../db"

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params

	// Next.js records a thrown error on its render span, so this span only times the call
	const project = await traced("load project", () => db.project.findUnique({ where: { id } }), {
		isFailure: () => false,
	})
	if (!project) notFound()

	return <h1>{project.name}</h1>
}
```

If the query throws, the trace shows the `load project` span with its duration and the render span above it with the exception.

## Trace client-side data fetching

Requests from client components, whether in `useEffect`, SWR, or React Query, get `fetch` spans without any extra work. Wrapping the fetcher in `MapleBrowser.traced` gives the request a name you'll recognize in a list of traces:

```tsx
// src/app/projects/[id]/members-list.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"
import { useQuery } from "@tanstack/react-query"

type Member = { id: string; name: string }

export function MembersList({ projectId }: { projectId: string }) {
	const { data: members = [] } = useQuery({
		queryKey: ["members", projectId],
		queryFn: () =>
			MapleBrowser.traced("query members", async () => {
				const res = await fetch(`/api/projects/${projectId}/members`)
				return (await res.json()) as Member[]
			}),
	})

	return (
		<ul>
			{members.map((member) => (
				<li key={member.id}>{member.name}</li>
			))}
		</ul>
	)
}
```

These also end up as their own traces rather than under the `navigate` span. The new page's effects run after the commit that ends the navigation, so by the time the query starts, there's no navigation left to attach to. The `fetch` inside still carries `traceparent`, so your API's spans join the `query members` trace.

## Report errors from error.tsx and global-error.tsx

Every `error.tsx` is a React error boundary, and it receives the error as a prop. Report it from an effect with `reportNextError`:

```tsx
// src/app/error.tsx
"use client"

import { reportNextError } from "@maple-dev/browser/nextjs"
import { useEffect } from "react"

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
	useEffect(() => reportNextError(error), [error])

	return (
		<main>
			<h2>Something went wrong</h2>
			<button onClick={retry}>Try again</button>
		</main>
	)
}
```

Errors thrown in the root layout skip `error.tsx` and go to `global-error.tsx`, which replaces the whole document. Report from there the same way:

```tsx
// src/app/global-error.tsx
"use client"

import { reportNextError } from "@maple-dev/browser/nextjs"
import { useEffect } from "react"

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
	useEffect(() => reportNextError(error), [error])

	return (
		<html lang="en">
			<body>
				<h2>Something went wrong</h2>
			</body>
		</html>
	)
}
```

`reportNextError` records the error as `react.render_error`, and skips two kinds:

- **Errors with a `digest`.** In production, an error thrown in a Server Component reaches the browser as a generic React error, with the message removed and a `digest` added. Reporting that from the browser would group every server error into one meaningless issue. You don't lose anything by skipping it: Next.js records the original exception, message and stack included, on its own server span (`render route (app) /projects/[id]`, or `RSC GET /projects/[id]` on a client navigation) and marks it as an error, so it's already on the Errors page. For the same reason you don't need the `onRequestError` hook in `instrumentation.ts`: with OpenTelemetry set up, it would record every server error a second time.
- **Errors `traced` already recorded** on a data-loading span.

A client component that throws on every render shows up twice on a full page load: once on the server render span, where it turned the response into a 500, and once from `error.tsx`, when the browser renders the component again and it throws again. Those are two executions of the bug, not one error reported twice. After a client navigation, only the browser one happens.

## Link the first page load to the server render

To join the browser's `pageload` span to the server render, the server hands its trace context to the browser in a `Server-Timing` header. Next.js doesn't give pages a way to set response headers: `headers()` in a Server Component only reads the request. What can set them is `proxy.ts` (called `middleware.ts` before Next.js 16), which runs before the render. `withMapleProxy` creates one:

```ts
// src/proxy.ts
import { withMapleProxy } from "@maple-dev/browser/nextjs/server"

export const proxy = withMapleProxy()

export const config = {
	matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}
```

If you already have a proxy, pass it in, and keep your own matcher. Your function runs first, and its responses pass through:

```ts
// src/proxy.ts
import { withMapleProxy } from "@maple-dev/browser/nextjs/server"
import { type NextRequest, NextResponse } from "next/server"

export const proxy = withMapleProxy((request: NextRequest) => {
	if (!request.cookies.has("session")) return NextResponse.redirect(new URL("/login", request.url))
})
```

Next.js runs the proxy inside its own `middleware GET` span. `withMapleProxy` puts that span's context in the `traceparent` request header, which Next.js reads when it starts the render's root span, and in the `Server-Timing` response header, which the browser reads. The first page load becomes one trace: `middleware GET` at the root, with the `GET /projects/[id]` render and the browser's `pageload` span under it.

- **Only responses that go on to a render in your app change.** That's `NextResponse.next()`, a rewrite to the same origin, or no response at all. Redirects, responses your proxy builds itself, and rewrites to another origin pass through unchanged.
- **A `traceparent` the request already carries is kept.** The RSC requests from client navigations carry the browser's, and replacing it would cut them off from the browser `fetch` span that made them.

This works with `next start` on Node. Next.js only reads the incoming `traceparent` when no span is active yet, so on a platform that starts its own server span first, or that runs the proxy separately from your app, the render may not join. After deploying, open one page load in Maple and check that the `pageload` span shares a trace with the server spans.

The proxy runs on every request it matches, including prerendered pages and `304` revalidations, so each response gets a fresh header. That changes if a shared cache such as a CDN sits in front of `next start`: Next.js sends prerendered HTML with a long `s-maxage`, the cache would store the header, and every visitor would join the same trace. In that setup, leave prerendered routes out of the matcher or use the option below.

If the page load doesn't join, Next.js has an experimental option that does the injection itself. `experimental.clientTraceMetadata: ["traceparent"]` in `next.config.ts` renders a `<meta name="traceparent">` tag with the render's trace context into every dynamically rendered page. The SDK reads that tag when there's no header, so you can use it instead of the proxy.

## Next.js-specific gotchas

- **The pageload span measures hydration, not the full load.** It starts when `instrumentation-client.ts` runs and ends after the first commit. The time before that is in the server spans and the browser's navigation timing.
- **Development doubles effects.** React Strict Mode runs effects twice in `next dev`. The second end finds nothing open and does nothing, so traces look the same, but the dev server's timings are nothing like production.
- **Static pages have no render to join.** With the proxy, a prerendered page's `pageload` span still joins the proxy's trace, but there's no render span under it, because nothing rendered. With `clientTraceMetadata`, prerendered pages get no `<meta>` tag, and their `pageload` span is its own trace.
- **Some route templates are ambiguous.** Templates are rebuilt by matching param values from the end of the path, so a static segment after a param with the same value (`/users/settings/settings` for `/users/[name]/settings`) can be named wrong. `useParams()` can't tell an optional catch-all from a required one either: with `[[...slug]]`, `/docs` is `navigate /docs` and `/docs/a` is `navigate /docs/[...slug]`.
- **`basePath` and hash entries.** With a `basePath`, going back or forward to a history entry that only differs by its hash can open a span that ends as interrupted.
- **`global-error.tsx` replaces the root layout.** It unmounts `MapleNavigation`, so the navigation that hit the error ends as interrupted at the next navigation, or when the page is left.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does Next.js have built-in OpenTelemetry support?

On the server, yes. Next.js emits spans for requests, rendering, route handlers, and `fetch()`, and `@vercel/otel` exports them. There's nothing built in for the browser, which is what this guide adds. The [Next.js instrumentation guide](/docs/guides/instrumentation-nextjs) covers the server setup.

### Does this work with the Next.js Pages Router?

The SDK setup does, but `@maple-dev/browser/nextjs` is for the App Router. For navigations, the Pages Router has `router.events`: call `MapleBrowser.startNavigation` with the new path on `routeChangeStart`, and `MapleBrowser.endNavigation(router.pathname)` on `routeChangeComplete` and `routeChangeError`. There, `router.pathname` is already the route template, like `/projects/[id]`. Report errors from your error boundary with `MapleBrowser.captureException(error)`.

### Why aren't my Next.js server spans under the navigate span?

Next.js fetches Server Component data from inside its router, where no span of yours is active. That request is still traced, with the server render under it, as its own `GET ...?_rsc=` trace. Look for it by time and session, or open the session replay, which links every trace from the session.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

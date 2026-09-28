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

Next.js has a file for this. `instrumentation-client.ts` runs after the HTML loads and before React hydrates, so the SDK is running before any of your components do. It's available from Next.js 15.3, and it goes next to `instrumentation.ts`:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"
import { startNavigation } from "./tracing"

MapleBrowser.init({
	ingestKey: process.env.NEXT_PUBLIC_MAPLE_INGEST_KEY!, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: process.env.NODE_ENV,
})

// Next.js only reports client-side navigations, so the first page load starts here
startNavigation(location.pathname)

export { onRouterTransitionStart } from "./app/navigation-tracing"
```

Next.js inlines `NEXT_PUBLIC_*` variables at build time, so set the key where you build, not only where you run. It has to be the public `maple_pk_` key, never the private one.

The `startNavigation` call opens the `pageload` span. It starts when this file runs, after the HTML and its JavaScript have downloaded, so it covers hydration but not the time to first byte. The server's half of the trace covers that part, once the two are linked (the last section below).

If you followed the [Browser SDK docs](/docs/session-replay/browser-sdk#nextjs), which initialize from a client component in the root layout, that works too. `instrumentation-client.ts` runs earlier and doesn't depend on rendering.

The `./tracing` helper and `./app/navigation-tracing` are added in the sections below.

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

## Add the tracing helper

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to the App Router:

```ts
// src/tracing.ts
import { context, propagation, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("acme-web")

let navigation: { span: Span; kind: "pageload" | "navigate" } | undefined
let firstLoad = true

/** Call when the router starts a navigation. */
export function startNavigation(path: string) {
	// A click before the last navigation finished replaces it
	navigation?.span.setAttribute("app.navigation.interrupted", true)
	navigation?.span.end()

	const kind = firstLoad ? "pageload" : "navigate"
	// Only the first page load belongs to the server's trace, if there was one
	const parent = firstLoad ? serverContext() : context.active()
	firstLoad = false

	navigation = { kind, span: tracer.startSpan(kind, { attributes: { "url.path": path } }, parent) }
}

/** Call when the new route is ready. `route` is its template, like `/projects/:id`. */
export function endNavigation(route?: string) {
	if (!navigation) return
	if (route) navigation.span.updateName(`${navigation.kind} ${route}`)
	navigation.span.end()
	navigation = undefined
}

const recorded = new WeakSet<object>()

/** Run `fn` in a span under the current navigation. */
export function traced<T>(
	name: string,
	fn: () => Promise<T>,
	isFailure: (error: unknown) => boolean = () => true,
): Promise<T> {
	const parent = navigation ? trace.setSpan(context.active(), navigation.span) : context.active()

	return tracer.startActiveSpan(name, {}, parent, async (span) => {
		try {
			return await fn()
		} catch (error) {
			if (isFailure(error)) {
				// Some libraries throw error-like objects that aren't Error instances
				span.recordException(error instanceof Error ? error : String((error as { message?: unknown })?.message ?? error))
				span.setStatus({ code: SpanStatusCode.ERROR })
				if (typeof error === "object" && error !== null) recorded.add(error)
			}
			throw error
		} finally {
			span.end()
		}
	})
}

/** Whether `traced` already recorded this error on a span. */
export const alreadyRecorded = (error: unknown) =>
	typeof error === "object" && error !== null && recorded.has(error)

/** The trace the server rendered this page under, from a `Server-Timing` header or a `<meta>` tag. */
function serverContext() {
	if (typeof document === "undefined") return context.active()
	const [page] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
	const traceparent =
		page?.serverTiming?.find((entry) => entry.name === "traceparent")?.description ||
		document.querySelector<HTMLMetaElement>('meta[name="traceparent"]')?.content
	return traceparent ? propagation.extract(context.active(), { traceparent }) : context.active()
}
```

- `startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `endNavigation(route)` names the span after the route template and ends it.
- `traced(name, fn, isFailure)` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`.
- `alreadyRecorded(error)` tells you whether `traced` already recorded an error, so it isn't reported twice.
- `serverContext()` joins the first page load to the server's trace when the server sent its trace context, in a `Server-Timing` header or a `<meta name="traceparent">` tag. In a client-only app it does nothing.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

### The await problem

Browsers have no equivalent of Node's `AsyncLocalStorage`, so OpenTelemetry's web context manager only tracks the active span synchronously. Inside `traced`, a `fetch()` called before the first `await` nests under the span. A `fetch()` called after it starts a new trace:

```ts
// Both requests nest under the span
traced("load project", () => Promise.all([fetchProject(id), fetchMembers(id)]))

// The second request loses its parent
traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id) // new trace
	return { project, members }
})
```

When a request depends on an earlier one, capture the context before the first `await` with `const ctx = context.active()`, and make the request with `context.with(ctx, () => fetchMembers(project.id))`. Sequential awaits while loading a page are also a request waterfall, so check whether the requests can run in parallel first.

## Trace App Router navigations

The App Router gives you one of the two events the helper needs. `instrumentation-client.ts` can export `onRouterTransitionStart(url, navigationType)`, which Next.js calls when a navigation starts: a `<Link>` click, `router.push()`, `router.replace()`, or the back and forward buttons.

There's no matching event for the end. That comes from React instead: a client component that reads the current route and ends the span in an effect, which runs once the new route is committed. Both halves live in one file, because they share the `committed` variable:

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

Render it in the root layout, above `{children}`:

```tsx
// src/app/layout.tsx
import { Suspense } from "react"
import { NavigationTracing } from "./navigation-tracing"

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>
				{/* useSearchParams() needs a Suspense boundary on statically rendered pages */}
				<Suspense>
					<NavigationTracing />
				</Suspense>
				{children}
			</body>
		</html>
	)
}
```

The re-export at the bottom of `instrumentation-client.ts` hands `onRouterTransitionStart` to Next.js. A few details:

- **The route template is rebuilt from the params.** Next.js doesn't expose the matched route pattern on the client, so `routeTemplate` replaces each value from `useParams()` with its name. `/projects/8f2a` becomes `/projects/[id]`, and the catch-all `/docs/a/b` becomes `/docs/[...slug]`.
- **Hash links are skipped.** Next.js calls `onRouterTransitionStart` for a link to `#pricing` too, but nothing renders, so the span would never end. The `committed` check skips any navigation to the pathname and query already on screen.
- **Query changes are navigations.** Going from `?tab=1` to `?tab=2` makes Next.js fetch new Server Component data, so it gets a span. That's why the component reads `useSearchParams()`, and that hook is why it's inside `<Suspense>`: Next.js fails the build when a statically rendered page calls it outside one.
- **Redirects produce two spans.** When a Server Component calls `redirect()` during a client navigation, Next.js renders the redirect first and then starts a second navigation. You'll see `navigate /old` followed by `navigate /new`.
- **The span ends at the commit, not when all data has arrived.** If the route has a `loading.tsx`, the loading state is committed first, and the span ends when the skeleton appears. Content that streams into Suspense boundaries afterwards isn't part of it.

## Trace data loading in Server Components

In the App Router, most data loading happens in Server Components, so it's server-side tracing, and Next.js does most of it for you. On a client navigation, the router fetches the new route's Server Component payload from the same URL with an `_rsc` query parameter. The browser SDK instruments that `fetch` and sends `traceparent` with it, because it's same-origin. On the server, Next.js continues that trace with an `RSC GET /projects/[id]` span, the render, and every `fetch()` your components make.

That request doesn't nest under the `navigate` span. Next.js makes it from inside its router, where your code can't wrap it, and without async context in the browser the navigation span can't reach it on its own. So a click gives you two traces that overlap in time and share a session id: the `navigate` span for what the user waited for, and the `GET ...?_rsc=` trace with the server work behind it.

Two more things to expect in the trace list:

- **Prefetches are traced too.** `<Link>` prefetches routes as they scroll into view, and each prefetch is its own `GET ...?_rsc=` trace. That's real work your server did, just before the click.
- **Some navigations take a few milliseconds.** A navigation to a prefetched static route often makes no request at all. That's the prefetch working.

Next.js's spans cover the render and `fetch()`, but not database queries or SDK calls. Wrap those with `traced` from the helper. On the server there's no navigation in progress, so `traced` parents to the active span, which is Next.js's render span. Node has `AsyncLocalStorage`, so requests after an `await` keep their parent too.

`redirect()` and `notFound()` work by throwing, and they aren't failures. Next.js's `unstable_rethrow` rethrows exactly the errors it uses for control flow, including the ones it throws internally while prerendering, so it makes a good `isFailure` check:

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

```tsx
// src/app/projects/[id]/page.tsx
import { notFound } from "next/navigation"
import { dataSpan } from "../../../data-span"

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params

	const project = await dataSpan("load project", async () => {
		const res = await fetch(`https://api.acme.com/projects/${id}`)
		if (res.status === 404) notFound()
		return (await res.json()) as { name: string }
	})

	return <h1>{project.name}</h1>
}
```

## Trace client-side data fetching

Requests from client components, whether in `useEffect`, SWR, or React Query, get `fetch` spans without any extra work. Wrapping the fetcher in `traced` gives the request a name you'll recognize in a list of traces:

```tsx
// src/app/projects/[id]/members-list.tsx
"use client"

import { useQuery } from "@tanstack/react-query"
import { traced } from "../../../tracing"

type Member = { id: string; name: string }

export function MembersList({ projectId }: { projectId: string }) {
	const { data: members = [] } = useQuery({
		queryKey: ["members", projectId],
		queryFn: () =>
			traced("query members", async () => {
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

Every `error.tsx` is a React error boundary, and it receives the error as a prop. Report it from an effect:

```tsx
// src/app/error.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"
import { useEffect } from "react"
import { alreadyRecorded } from "../tracing"

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
		// Server errors arrive with a digest and without their message.
		// Next.js already recorded the real error on its server span.
		if (error.digest || alreadyRecorded(error)) return
		MapleBrowser.captureException(error, { name: "react.render_error" })
	}, [error])

	return (
		<main>
			<h2>Something went wrong</h2>
			<button onClick={reset}>Try again</button>
		</main>
	)
}
```

The `digest` check is the Next.js-specific part. In production, an error thrown in a Server Component reaches the browser as a generic React error, with the message removed and a `digest` added. Reporting that from the browser would group every server error into one meaningless issue.

You don't lose anything by skipping it. Next.js records the original exception, message and stack included, on its own server span (`render route (app) /projects/[id]`, or `RSC GET /projects/[id]` on a client navigation) and marks it as an error, so it's already on the Errors page. For the same reason you don't need the `onRequestError` hook in `instrumentation.ts`: with OpenTelemetry set up, it would record every server error a second time.

Errors thrown in the root layout skip `error.tsx` and go to `global-error.tsx`, which replaces the whole document:

```tsx
// src/app/global-error.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"
import { useEffect } from "react"

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
	useEffect(() => {
		if (!error.digest) MapleBrowser.captureException(error, { name: "react.render_error" })
	}, [error])

	return (
		<html lang="en">
			<body>
				<h2>Something went wrong</h2>
			</body>
		</html>
	)
}
```

## Link the first page load to the server render

To join the browser's `pageload` span to the server render, the server hands its trace context to the browser in a `Server-Timing` header, which `serverContext()` in the helper reads. Next.js doesn't give pages a way to set response headers: `headers()` in a Server Component only reads the request. What can set them is `proxy.ts` (called `middleware.ts` before Next.js 16), which runs before the render:

```ts
// src/proxy.ts
import { context, propagation } from "@opentelemetry/api"
import { type NextRequest, NextResponse } from "next/server"

export function proxy(request: NextRequest) {
	const carrier: Record<string, string> = {}
	propagation.inject(context.active(), carrier)

	// Client navigations already carry the browser's traceparent: leave those alone
	if (request.headers.has("traceparent") || !carrier.traceparent) return NextResponse.next()

	// The render joins this trace through the request header...
	const headers = new Headers(request.headers)
	headers.set("traceparent", carrier.traceparent)
	const response = NextResponse.next({ request: { headers } })
	// ...and the browser's pageload span joins it through this one
	response.headers.set("server-timing", `traceparent;desc="${carrier.traceparent}"`)
	return response
}

export const config = {
	matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}
```

Next.js runs the proxy inside its own `middleware GET` span. The proxy puts that span's context in the `traceparent` request header, which Next.js reads when it starts the render's root span, and in the `Server-Timing` response header, which the browser reads. The first page load becomes one trace: `middleware GET` at the root, with the `GET /projects/[id]` render and the browser's `pageload` span under it.

Requests that already have a `traceparent` are skipped. Those are the RSC requests from client navigations, and replacing their header would cut them off from the browser `fetch` span that made them.

This works with `next start` on Node. Next.js only reads the incoming `traceparent` when no span is active yet, so on a platform that starts its own server span first, or that runs the proxy separately from your app, the render may not join. After deploying, open one page load in Maple and check that the `pageload` span shares a trace with the server spans.

If it doesn't, Next.js has an experimental option that does the injection itself. `experimental.clientTraceMetadata: ["traceparent"]` in `next.config.ts` renders a `<meta name="traceparent">` tag with the render's trace context into every dynamically rendered page. The helper's `serverContext()` reads that tag when there's no header, so you can use it instead of the proxy.

## Next.js-specific gotchas

- **The pageload span measures hydration, not the full load.** It starts when `instrumentation-client.ts` runs and ends after the first commit. The time before that is in the server spans and the browser's navigation timing.
- **Development doubles effects.** React Strict Mode runs effects twice in `next dev`. The second `endNavigation` finds nothing open and does nothing, so traces look the same, but the dev server's timings are nothing like production.
- **Static pages have no render to join.** A prerendered page's `pageload` span still joins the proxy's trace, but there's no render span under it, because nothing rendered.

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

The SDK setup and error reporting do. For navigations, the Pages Router has `router.events` with `routeChangeStart` and `routeChangeComplete`, which map onto `startNavigation` and `endNavigation` more directly than the App Router hooks. There, `router.pathname` is already the route template, like `/projects/[id]`, so you don't need `routeTemplate`.

### Why aren't my Next.js server spans under the navigate span?

Next.js fetches Server Component data from inside its router, where no span of yours is active. That request is still traced, with the server render under it, as its own `GET ...?_rsc=` trace. Look for it by time and session, or open the session replay, which links every trace from the session.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.

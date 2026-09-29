# @maple-dev/browser

Browser SDK for [Maple](https://maple.dev) — OpenTelemetry tracing **and** rrweb
session replay in a single package. Every span and every replay event is tagged
with the same `session.id`, so a trace can link straight to the replay that
produced it (and vice versa) with no clock-skew guessing.

## Install

```bash
npm install @maple-dev/browser
```

## Usage

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public ingest key
	serviceName: "acme-web",
	region: "eu", // "us" (default) or "eu"; must match your organization's region
	environment: "production",
	replay: { enabled: true, sampleRate: 1.0 },
	privacy: { maskAllInputs: true },
})
```

That single call:

- starts OTel browser tracing, auto-instrumenting `fetch`, exporting to Maple's
  ingest (`POST /v1/traces`);
- records the session with rrweb, chunking events (~5s / 100KB windows),
  gzipping them with the native `CompressionStream`, and uploading to
  `POST /v1/sessionReplays/blob`. rrweb ships in a lazy code-split chunk loaded
  only once a session is sampled in, so a `sampleRate` below 1 costs the
  unsampled visitors nothing beyond the base SDK (see [Bundle size](#bundle-size));
- writes session metadata at start (`active`) and on page hide (`ended`),
  including the trace ids observed during the session;
- captures uncaught errors and unhandled promise rejections as error spans, so
  browser crashes reach Maple's error tracking.

## Errors

Every uncaught error and unhandled rejection becomes a span with status `Error`
and an `exception` event, which is the shape Maple fingerprints — so browser
crashes group beside your server-side errors instead of in a silo.

Errors your app _catches_ never reach the global handlers, because catching them
is what stops them. Report those explicitly:

```ts
try {
	render()
} catch (error) {
	MapleBrowser.captureException(error, { name: "browser.render_error" })
}
```

Opt out of the global handlers with `tracing: { captureErrors: false }` — worth
doing only when another tracker already owns them, or the same crash is recorded
twice.

A cross-origin script reports to the browser as a bare `"Script error."` with no
stack and no filename. Those are dropped rather than recorded: they all
fingerprint to one contentless issue that buries the real ones. Add
`crossorigin` to the script tag to get the real error instead.

## Bundle size

Bundled, minified and gzipped, as your bundler would ship it:

|                  | gzipped | what it is                                                |
| ---------------- | ------- | --------------------------------------------------------- |
| **eager**        | ~36 kB  | every page load, before any sampling decision             |
| ↳ our code alone | ~13 kB  | the marginal cost if your app already ships OpenTelemetry |
| **lazy**         | ~61 kB  | rrweb — downloaded only by sessions sampled into replay   |

The eager figure is ~90% OpenTelemetry. If your app already uses the OTel web
SDK, your bundler should dedupe it and you pay closer to the second row; if it
doesn't dedupe, you will ship two copies, so pin matching versions.

Run `bun run size` in this package for the current numbers. It fails past a
budget, so a regression has to be argued for in review rather than discovered
in production.

## Identifying users

Pass `userId` to `init()` when you already know the signed-in user, or call
`MapleBrowser.identify(user.id)` later. The id is attached to future session
metadata rows and stamped as `user.id` on future browser-created spans.

```ts
MapleBrowser.identify(user.id)

// or the full identity — email, name, and the company/team to group by
MapleBrowser.identify({
	id: user.id,
	email: user.email,
	groupId: org.id,
	groupName: org.name,
	traits: { plan: "pro" },
})

// after sign-out
MapleBrowser.identify(null)
```

Each call replaces the identity rather than merging it.

## Custom events

`track(name, props)` records a product event as a `session_events` row with
`Type='custom'`, so it shows up inline in the session transcript rather than in
a separate analytics silo. Calls before `init()` finishes are queued.

```ts
MapleBrowser.track("checkout_completed", { plan: "pro", seats: 12 })
```

## Regions

Maple runs separate US and EU instances, and an ingest key only works in the
region it was created in. Set `region: "eu"` for an organization on
`app.eu.maple.dev`; the SDK then sends to `https://ingest.eu.maple.dev`. An
explicit `endpoint` (a proxy, or self-hosted ingest) always wins over `region`.

## Tracing across origins

`fetch` spans carry the W3C `traceparent` header to same-origin requests only.
When your API lives on another origin, list it so browser and backend spans
join one trace, and allow the `traceparent` header in the API's CORS policy:

```ts
MapleBrowser.init({
	// ...
	tracing: { propagateTraceHeaderCorsUrls: [/^https:\/\/api\.example\.com\//] },
})
```

## Navigations and data loading

Call these from your router's hooks to make one click one trace: a navigation
span, the data-loading spans under it, and the `fetch` spans they start.
[maple.dev/docs/frontend](https://maple.dev/docs/frontend) shows where for each
framework.

```ts
MapleBrowser.startNavigation(location.pathname) // a navigation starts
const data = await MapleBrowser.traced("loader /projects/:id", () => load(id), {
	isFailure: (error) => !isRedirect(error), // redirects aren't failures
})
MapleBrowser.endNavigation("/projects/:id") // the route is ready: its template
```

- The first `startNavigation` opens a `pageload` span, joined to the server
  render's trace from a `Server-Timing: traceparent;desc="…"` entry or a
  `<meta name="traceparent">` tag; later calls open `navigate` spans, and end
  one still open as `app.navigation.interrupted`.
- `traced` returns `fn`'s result and rethrows its error unchanged. Only requests
  started before `fn`'s first `await` nest under its span. An error it recorded
  isn't reported again by `captureException` or the global handlers.
- In the browser, all three are no-ops before `init()`, with tracing disabled or
  without consent (`traced` then only runs `fn`).
- On the server, `startNavigation` and `endNavigation` do nothing, and `traced`
  spans through the server's own OpenTelemetry setup (see below).

## Server-side data loading

`@maple-dev/browser/server` depends on `@opentelemetry/api` only, so it runs in
Node, edge runtimes and Workers:

```ts
import { serverTiming, traced } from "@maple-dev/browser/server"

// A Server Component, SSR loader or resolver: a span under the active server span
const project = await traced("db.query project", () => db.project.find(id))

// Your framework's response hook: joins the browser's page load to this trace
const value = serverTiming()
if (value) headers.append("server-timing", value)
```

- `traced` spans through the global tracer the server registered (`@vercel/otel`,
  the Node SDK), so it nests under the request span and keeps its parent across
  `await`. An error is recorded once, like in the browser. Without server OpenTelemetry it
  only runs `fn`. `MapleBrowser.traced` does the same when there is no `window`.
- `serverTiming()` returns `traceparent;desc="00-…"` for the active span, or
  `undefined` when none is active.

## Next.js

`@maple-dev/browser/nextjs` wires the App Router (Next.js 15.3+) to the
navigation spans:

```ts
// src/instrumentation-client.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({ ingestKey: "maple_pk_...", serviceName: "acme-web" })
MapleBrowser.startNavigation(location.pathname) // the page load
export { onRouterTransitionStart } from "@maple-dev/browser/nextjs"
```

```tsx
// src/app/layout.tsx: render it once, above {children}
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

```tsx
// src/app/error.tsx (and global-error.tsx)
"use client"
import { reportNextError } from "@maple-dev/browser/nextjs"
import { useEffect } from "react"

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
	useEffect(() => reportNextError(error), [error])
	return <h2>Something went wrong</h2>
}
```

```ts
// src/proxy.ts (middleware.ts before Next.js 16): joins the page load to the render
import { withMapleProxy } from "@maple-dev/browser/nextjs/server"

export const proxy = withMapleProxy() // or withMapleProxy(yourProxy)
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] }
```

- Spans are named after the route, like `navigate /projects/[id]`; a URL no
  route matches is `/_not-found`. Hash links start no span.
- `reportNextError` skips server errors (they arrive with a `digest`, and Next.js
  already recorded them on its server span) and errors `traced` recorded.
- `withMapleProxy` keeps a `traceparent` the request already carries (client
  navigations), and only touches responses that go on to a render in this app:
  your redirects and responses pass through unchanged. Leave prerendered pages a
  shared cache (CDN) stores out of the matcher, or every visitor joins one trace.
- The browser follows the server's sampling decision: a page load under an
  unsampled server trace isn't recorded.

## Astro

`@maple-dev/browser/astro` is an Astro integration (Astro 5+): page loads,
`<ClientRouter />` navigations and on-demand renders, nothing in the layouts:

```js
// astro.config.mjs
import maple from "@maple-dev/browser/astro"
import { defineConfig } from "astro/config"

export default defineConfig({ integrations: [maple()] })
```

```astro
<!-- the base layout's <head>: init stays yours (functions, PUBLIC_ env vars) -->
<script>
	import { MapleBrowser } from "@maple-dev/browser"
	MapleBrowser.init({ ingestKey: import.meta.env.PUBLIC_MAPLE_INGEST_KEY, serviceName: "acme-web" })
</script>
```

- Spans are named after `Astro.routePattern` (`navigate /projects/[id]`), which
  the integration's middleware writes on each page's `<html data-route>`, at
  build time for prerendered pages.
- Without `<ClientRouter />`: one `pageload` per document, ended at `load`.
  With it: a `navigate` span per navigation with the page request under it;
  interrupted navigations and full-page-load fallbacks keep the generic name.
- Island code that fails to load is reported as `astro.hydration_error`.
- On-demand pages run in an `ssr <route>` span and send `Server-Timing` (with
  server OpenTelemetry), except responses a cache may replay: Astro's route
  cache, `Cache-Control` with `public`/`s-maxage`/`max-age` > 0,
  `CDN-Cache-Control` and its vendor variants.
- Without the integration: `export { onRequest } from "@maple-dev/browser/astro/middleware"`
  in `src/middleware.ts`, and `traceAstroNavigation()` from
  `@maple-dev/browser/astro/client` in the layout script, after `init`.

## Linking a marketing site to your app

The visitor id lives in localStorage **and** a cookie scoped to your registered
domain, so `example.com` and `app.example.com` resolve to the same `VisitorId`
and an anonymous pre-signup visit links to the account it becomes. Session ids
stay per-origin; `VisitorId` is the join key. Override the scope with
`privacy.crossSubdomainCookie` / `privacy.cookieDomain`.

## Privacy

`maskAllInputs` (default **on**) masks every `<input>` value. Use rrweb's
attribute hooks (`data-rr-block`, `.rr-block`, `.rr-ignore`) to block elements
or subtrees from capture.

URLs are redacted before they leave the page: the values of credential-shaped
query and fragment parameters (`token`, `code`, `access_token`, `password`, …)
become `REDACTED` in session rows, events, network events, replay meta events
and span attributes. Add your own rewriting with `privacy.sanitizeUrl`, for
example to collapse ids in paths:

```ts
privacy: {
	sanitizeUrl: (url) => url.replace(/\/users\/\d+/, "/users/:id")
}
```

`privacy.requireConsent` holds all capture until `MapleBrowser.setConsent(true)`.
Global Privacy Control is honored by default and suppresses the persistent
visitor id; `doNotTrack` is not, unless `privacy.respectDoNotTrack` is set.

## Notes

- Replay event blobs live in object storage; only small, queryable metadata is
  indexed — playback streams blobs directly via signed URLs.
- The SDK is best-effort: network failures in telemetry never throw into your
  app.

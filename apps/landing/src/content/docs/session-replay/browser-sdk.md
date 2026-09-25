---
title: "Browser SDK"
description: "Instrument a website with OpenTelemetry tracing, error capture and session replay using the @maple-dev/browser SDK."
group: "Session Replay"
order: 1
---

`@maple-dev/browser` adds OpenTelemetry tracing, error capture and session replay to a website in one package. Every span and every replay event carries the same `session.id`, so a trace links to the replay that produced it, and a replay links to its traces.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Browsers</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Beta</span>
</div>

> **Using Effect?** The browser entry point of `@maple-dev/effect-sdk` has the same replay engine built in, with the recorder in a lazily loaded chunk. See [Session Replay & Sessions](/docs/sdks/effect-client#session-replay-and-sessions). Run replay from one SDK, not both.

## Install

```bash
npm install @maple-dev/browser
```

## Quick start

Call `MapleBrowser.init` once, as early as possible in your app's entrypoint:

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public ingest key
	serviceName: "acme-web",
	region: "eu", // only for EU organizations; omit for the US region
})
```

Use a **public** ingest key (`maple_pk_…`) from **Settings → Ingestion**. It is safe to ship in browser code. Ingest keys belong to one region, so set `region: "eu"` if your organization is in the EU region.

That single call:

- starts OpenTelemetry browser tracing, auto-instrumenting `fetch` and exporting to Maple's ingest (`POST /v1/traces`);
- records uncaught errors and unhandled promise rejections as error spans;
- records the session with rrweb, in chunks of about 5 seconds or 100 KB, gzipped with the browser's `CompressionStream` and uploaded to `POST /v1/sessionReplays/blob`;
- writes session metadata at start (`active`) and on page hide (`ended`), including the trace ids observed during the session.

The SDK is best-effort. A telemetry network failure never throws into your app.

`init()` returns a handle, `{ sessionId, shutdown }`, for reading the active session id and tearing telemetry down. See [Sessions](#sessions).

## Configuration

Every field accepted by `MapleBrowser.init`:

| Option                                 | Type                          | Default                    | Description                                                                                                                                                                  |
| -------------------------------------- | ----------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serviceName`                          | `string`                      | none                       | **Required.** Service name reported on traces and stored on replay sessions.                                                                                                  |
| `ingestKey`                            | `string`                      | none                       | Public ingest key (`maple_pk_...`), sent as `Authorization: Bearer`. Leave it unset only when `endpoint` points at your own proxy that adds the key.                          |
| `region`                               | `"us"` \| `"eu"`              | `"us"`                     | Region of your Maple organization. `"us"` sends to `https://ingest.maple.dev`, `"eu"` to `https://ingest.eu.maple.dev`. Ignored when `endpoint` is set.                        |
| `endpoint`                             | `string`                      | from `region`              | Ingest base URL. Overrides `region`. Use it for a proxy.                                                                                                                      |
| `serviceNamespace`                     | `string`                      | none                       | Logical group this service belongs to, sent as the `service.namespace` resource attribute on traces.                                                                         |
| `serviceVersion`                       | `string`                      | none                       | Service version or commit SHA, attached to traces.                                                                                                                           |
| `environment`                          | `string`                      | none                       | Deployment environment, for example `"production"`.                                                                                                                          |
| `user`                                 | `object`                      | none                       | End-user identity: `id`, `email`, `username`, `groupId`, `groupName`, `traits`. Attached to the session and to browser spans. See [Identifying users](#identifying-users).    |
| `userId`                               | `string`                      | none                       | **Deprecated.** A bare user id. Use `user` instead. When both are set, `user` wins.                                                                                          |
| `tracing.enabled`                      | `boolean`                     | `true`                     | Enable OpenTelemetry browser tracing.                                                                                                                                         |
| `tracing.instrumentFetch`              | `boolean`                     | `true`                     | Create spans for `fetch()` calls. Set `false` when another tracer (such as the Effect client SDK) already instruments requests, to avoid duplicate network spans.             |
| `tracing.captureErrors`                | `boolean`                     | `true`                     | Record uncaught errors and unhandled promise rejections as error spans. Turn it off only when another tool owns the page's global error handlers.                             |
| `tracing.propagateTraceHeaderCorsUrls` | `Array<string \| RegExp>`     | `[]`                       | Cross-origin URLs whose `fetch()` requests carry the `traceparent` header. See [Connect browser and backend traces](#connect-browser-and-backend-traces).                     |
| `replay.enabled`                       | `boolean`                     | `true`                     | Enable session recording.                                                                                                                                                    |
| `replay.sampleRate`                    | `number`                      | `1`                        | Fraction of sessions to record, `0` to `1`. See [Sampling](#sampling).                                                                                                        |
| `privacy.maskAllInputs`                | `boolean`                     | `true`                     | Mask all `<input>` values in the recording.                                                                                                                                  |
| `privacy.maskAllText`                  | `boolean`                     | `false`                    | Mask all text in the recording, and omit captured click-target text from session events.                                                                                     |
| `privacy.sanitizeUrl`                  | `(url: string) => string`     | none                       | Rewrite every URL before it leaves the page. See [Redacting URLs](#redacting-urls).                                                                                          |
| `privacy.persistVisitorId`             | `boolean`                     | `true`                     | Store a persistent visitor id (localStorage and cookie) so unique and returning visitors can be counted. Turning it off also deletes any id already stored.                  |
| `privacy.crossSubdomainCookie`         | `boolean`                     | `true`                     | Scope the visitor-id cookie to the registered domain so sibling subdomains share it. See [Linking a marketing site to your app](#linking-a-marketing-site-to-your-app).       |
| `privacy.cookieDomain`                 | `string`                      | probed                     | Explicit cookie `Domain=` (no leading dot). `""` forces a host-only cookie.                                                                                                  |
| `privacy.requireConsent`               | `boolean`                     | `false`                    | Capture nothing until `MapleBrowser.setConsent(true)`. See [Consent](#consent).                                                                                              |
| `privacy.captureUserEmail`             | `boolean`                     | `true`                     | Store the email passed to `identify()`.                                                                                                                                      |
| `privacy.respectDoNotTrack`            | `boolean`                     | `false`                    | Treat `navigator.doNotTrack` like Global Privacy Control (suppresses the persistent visitor id).                                                                             |

A fully-specified call:

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	environment: "production",
	serviceVersion: "1.4.2",
	user: currentUser ? { id: currentUser.id, email: currentUser.email } : undefined,
	tracing: {
		enabled: true,
		instrumentFetch: true,
		captureErrors: true,
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.example\.com\//],
	},
	replay: { enabled: true, sampleRate: 1.0 },
	privacy: { maskAllInputs: true, maskAllText: false },
})
```

## Sessions

Every span and replay event the SDK emits carries one **`session.id`** (a `crypto.randomUUID()` v4), created on the first `MapleBrowser.init` call. That shared id is what links a trace to the replay that produced it.

### Storage and continuity

The session is stored in `sessionStorage` under the key `maple.session`, so it **survives reloads within a tab**. `sessionStorage` is per tab, so **each tab or window gets its own session**. When `sessionStorage` is unavailable (for example in some private-browsing modes), the SDK keeps the session in memory for the life of the page.

Client-side route changes in a single-page app do **not** start a new session. The SDK tracks no router events. Session boundaries are purely time-based.

### Rotation

A new `session.id` is created when either limit is crossed, whichever comes first:

- **30 minutes idle.** No recorded activity for half an hour rotates the session.
- **24 hours old.** A hard cap on a session's lifetime regardless of activity, so a tab left open for days does not become one giant replay.

While replay is recording, each uploaded chunk marks the session active and pushes back the idle deadline, so a session that keeps recording stays whole.

### Start and end metadata

The SDK writes a small session-metadata row at two points:

- an **`active`** row when recording starts (and again on each reload);
- an **`ended`** row when the page is hidden or unloaded. It fires on `visibilitychange` to `hidden` (the reliable "leaving" signal on mobile) and on `pagehide` (tab close or navigation on desktop).

The `ended` row carries the session duration, the click count, and the **trace ids observed during the session**. Maple uses these to link traces and replays, and to fill the user and session columns on the Replays page. The unload write uses `keepalive`, so it survives the page going away.

### Accessing the session id

`init()` returns a handle whose `sessionId` is the active session's id. Use it to correlate Maple sessions with your own backend logs:

```ts
const { sessionId } = MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
})

// for example, forward it on your own requests
fetch("/api/checkout", { headers: { "x-maple-session": sessionId } })
```

`init()` is idempotent: calling it again returns the same live handle. On the server (SSR, no `window`) it returns a no-op handle with an empty `sessionId`.

### Teardown

Call `shutdown()` to upload the final replay chunk and stop tracing and replay. After it resolves, telemetry is stopped and a later `init()` may start a new session. Use it when a single-page app unmounts its telemetry client:

```ts
const maple = MapleBrowser.init({ ingestKey: "maple_pk_...", serviceName: "acme-web" })

// later, on teardown
await maple.shutdown()
```

## Identifying users

Pass `user` to `init()` so replays and traces are tied to a known user. It fills the user columns on the Replays page, and browser-created spans include `user.id`:

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	user: {
		id: "user_123",
		email: "ada@acme.com",
		username: "ada",
		groupId: "org_42",
		groupName: "Acme",
		traits: { plan: "pro", signup_month: "2026-01" },
	},
})
```

`groupId` and `groupName` are the company or team the Replays page can group by. `traits` are capped at 24 keys, 64-character keys and 256-character values. The identity is never written to browser storage.

If you do not know the user at init time (for example, the SDK starts before login resolves), leave `user` out and the session starts anonymous. Call `MapleBrowser.identify()` once you know who the user is. It takes the same object, or a bare user id:

```ts
// after the user signs in
MapleBrowser.identify({ id: user.id, email: user.email, groupId: org.id, groupName: org.name })

// after the user signs out
MapleBrowser.identify(null)
```

Each call **replaces** the identity. It does not merge, so a signed-out user's email never carries over to whoever signs in next on a shared device. Future session rows and spans read the latest identity.

`userId` still works as a bare user id, but it is deprecated. Use `user`.

## Capturing errors

With `tracing.captureErrors` on (the default), uncaught errors and unhandled promise rejections are recorded as error spans with status `Error`, which feed the [Errors](/docs/errors/overview) page.

An error your app catches never reaches those global handlers. Report it with `captureException`, for example from a framework error boundary:

```ts
try {
	await submitOrder()
} catch (error) {
	MapleBrowser.captureException(error, {
		name: "checkout.submit_failed", // span name, default "exception"
		attributes: { "order.step": "payment" },
	})
	showErrorToast()
}
```

The same error object is recorded once, even if your code reports it and then rethrows it. `captureException` accepts any thrown value: strings and plain objects are turned into an `Error`. Calls before `init()` do nothing.

A cross-origin script that throws shows up in the browser as a bare "Script error." with no details, and the SDK skips it. Add the `crossorigin` attribute to the script tag to get the real error.

## Connect browser and backend traces

For a request to the same origin as the page, the `fetch()` span sends a W3C `traceparent` header, and your backend's span joins the same trace. For a request to another origin, such as `https://api.example.com` from `https://app.example.com`, the header is not sent unless you list the URL:

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.example\.com\//],
	},
})
```

Your API must also allow the header in its CORS configuration. Add `traceparent` to `Access-Control-Allow-Headers` in the preflight response. Without it, the browser blocks the request.

Your backend must be instrumented with OpenTelemetry and read `traceparent`, which every OpenTelemetry HTTP server instrumentation does.

## Custom events

`track(name, props)` records a product event against the current session. It appears inline in the session transcript next to the clicks and network calls around it, and counts as a [product event](/docs/product-events/overview).

```ts
MapleBrowser.track("checkout_completed", { plan: "pro", seats: 12 })
```

Names are capped at 128 characters. Props are capped at 32 keys, 64-character keys, 1024-character values and 8 KB in total. Values are converted to strings (`Date` to ISO, objects to JSON; `null`, `undefined` and functions are dropped). Calls before `init()` finishes are queued, and `track()` never throws.

Every session event, page views and `track()` calls alike, carries the person it belongs to: the visitor id, plus the `id` and `groupId` from `identify()`. That is what lets a funnel follow one person from an anonymous marketing visit through sign-in, and lets browser events line up with the same user's [server-side events](/docs/sdks/effect-server#server-side-track). Identity is resolved when the batch is sent, so an `identify()` shortly after `init()` still lands on the first page view. The visitor id is empty when the visitor cookie is off (consent not granted, Global Privacy Control, `persistVisitorId: false`). Events from older SDK builds arrive with no identity.

## Linking a marketing site to your app

The visitor id is stored in **both** localStorage and a cookie scoped to your registered domain, so `example.com` and `app.example.com` resolve to the same visitor. Initialize the SDK on both and an anonymous visit links to the signed-in sessions it later becomes. On a replay, the link next to **Visitor ID** lists every session from that visitor, which shows the whole journey.

The **session** id is not shared: each origin keeps its own session, and the visitor id is the join key between them.

The SDK finds the cookie domain by probing, without a public-suffix list. Override it when the default is wrong:

```ts
MapleBrowser.init({
	// …
	privacy: {
		crossSubdomainCookie: true, // default; false keeps the cookie host-only
		cookieDomain: "example.com", // explicit override
	},
})
```

## Consent

Capture is on by default. Set `privacy.requireConsent` to hold everything until the user agrees, then call `setConsent()`:

```ts
MapleBrowser.init({ ingestKey, serviceName, privacy: { requireConsent: true } })

// once the banner is accepted
MapleBrowser.setConsent(true)
```

Revoking stops capture without uploading what is buffered, and a later grant starts a new session. Global Privacy Control is honored regardless of `requireConsent`. It suppresses the persistent visitor id (the one cross-session identifier the SDK stores) and leaves session-scoped capture alone. `doNotTrack` is ignored unless you set `privacy.respectDoNotTrack`. `privacy.persistVisitorId: false` turns the visitor id off entirely and deletes any already stored. `privacy.captureUserEmail: false` keeps the email from `identify()` out of Maple.

## Privacy and masking

`maskAllInputs` is **on by default**, so every `<input>` value is masked before it leaves the browser. Set `maskAllText: true` to also mask all rendered text.

To block specific elements or subtrees, use rrweb's attributes:

- `data-rr-block` attribute, or the `.rr-block` class: block an element and its subtree. It is recorded as a placeholder.
- `.rr-ignore` class: ignore input events on an element.

```html
<div class="rr-block">
	<!-- never captured in the replay -->
	<CreditCardForm />
</div>
```

### Redacting URLs

The SDK already replaces the values of credential-shaped query and fragment parameters (`token`, `code`, `access_token`, `password` and similar) in every URL it sends. To redact more, pass `privacy.sanitizeUrl`. It runs after the built-in redaction, on session entry and exit URLs, event rows, network events, replay metadata and span attributes:

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	privacy: {
		// hide invite codes in paths like /invite/abc123
		sanitizeUrl: (url) => url.replace(/\/invite\/[^/?#]+/, "/invite/:code"),
	},
})
```

## Sampling

To record only a fraction of sessions, set `replay.sampleRate` between `0` and `1`. For example, `0.1` records about 10% of sessions. Tracing is not affected.

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	replay: { sampleRate: 0.1 },
})
```

A value outside `0` to `1` is clamped, with a console warning.

## Session size limit

A single session records at most **1 GiB** of decompressed replay data. Past that, the recording is cut at a chunk boundary: earlier chunks stay playable, later ones are dropped, and the session is still listed with its metadata and linked traces.

Normal sessions are far below this. The limit stops a runaway recording, which in practice means canvas capture, unmasked media, or a page whose DOM changes continuously. `replay.sampleRate` does not help here, because it drops whole sessions. Mask or block the noisy subtree instead.

## Framework examples

### Plain HTML

```html
<script type="module">
	import { MapleBrowser } from "https://esm.sh/@maple-dev/browser"

	MapleBrowser.init({
		ingestKey: "maple_pk_...",
		serviceName: "acme-web",
	})
</script>
```

### React and Vite

Initialize at the top of your client entry point so it runs once before the app renders:

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
})
```

```ts
// src/main.tsx
import "./maple" // import first, before rendering
import { createRoot } from "react-dom/client"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(<App />)
```

### Next.js

Next.js exposes `NEXT_PUBLIC_*` variables through `process.env`, not `import.meta.env`. Initialize from a client component and render it in the root layout:

```tsx
// app/maple.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"

// init() is a no-op during server rendering, so module scope is safe here.
MapleBrowser.init({
	ingestKey: process.env.NEXT_PUBLIC_MAPLE_INGEST_KEY!,
	serviceName: "acme-web",
	environment: process.env.NODE_ENV,
})

export function Maple() {
	return null
}
```

```tsx
// app/layout.tsx
import { Maple } from "./maple"

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>
				<Maple />
				{children}
			</body>
		</html>
	)
}
```

## Verify

Load a page with the SDK installed, click around for a few seconds, then leave the tab.

1. Open **Traces** and filter by your `serviceName`. The page's `fetch()` spans appear within about a minute.
2. Open **Replays**. The session appears in the list. Open it to play the recording.
3. If you set `propagateTraceHeaderCorsUrls`, open a `fetch()` span in **Traces**. Your backend's span is in the same trace.

## Troubleshooting

- **Nothing arrives, and requests to the ingest endpoint return `401`.** The ingest key is wrong, or it belongs to the other region. EU keys need `region: "eu"`.
- **No replay, but traces arrive.** Check `replay.enabled` and `replay.sampleRate`, and whether `requireConsent` is on without a `setConsent(true)` call.
- **Cross-origin API calls fail after adding `propagateTraceHeaderCorsUrls`.** The API's CORS preflight does not allow `traceparent`. Add it to `Access-Control-Allow-Headers`.
- **Browser and backend spans are in separate traces.** The API origin is not in `propagateTraceHeaderCorsUrls`, or the backend does not read `traceparent`.
- **Each error appears twice.** Another tool on the page also handles uncaught errors and reports them to Maple. Set `tracing.captureErrors: false` so only one of them does.
- **Duplicate network spans.** Another tracer, such as the Effect client SDK, also instruments `fetch`. Set `tracing.instrumentFetch: false`.

## Notes

- Replay recordings are stored as compressed blobs. Only small, queryable metadata is indexed, and playback streams the blobs through signed URLs.
- The SDK is browser-only and best-effort. Telemetry network failures never surface to your application.

## Next steps

- [Replays](/docs/session-replay/replays): find and play back sessions.
- [Product events](/docs/product-events/overview): funnels on `track()` and server-side events.
- [Web analytics](/docs/product-events/web-analytics): visitors, pages and referrers from the same SDK.

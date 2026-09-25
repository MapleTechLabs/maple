# Browser SDK

`@maple-dev/browser` instruments a website with OpenTelemetry tracing **and** rrweb session replay in one package. Every span and every replay event carries the same `session.id`, so a trace links straight to the replay that produced it (and the reverse) with no clock-skew guessing.

> Session Replay is currently in **Beta**.

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
})
```

That call:

- starts OTel browser tracing, auto-instrumenting `fetch` and exporting to Maple's ingest (`POST /v1/traces`);
- captures uncaught errors and unhandled promise rejections as error spans (see [Errors](#errors));
- records the session with rrweb, chunks events into ~5s / 100KB windows, gzips them with the native `CompressionStream`, and uploads them to `POST /v1/sessionReplays/blob`;
- writes session metadata to `POST /v1/sessionReplays/meta`: an `active` row at start, a heartbeat every 60s, and an `ended` row on page hide, which includes the trace ids observed during the session.

The SDK is **best-effort**: network failures in telemetry never throw into your app.

`init()` returns a handle, `{ sessionId, shutdown }`, for reading the active session id and tearing telemetry down. See [Sessions](#sessions).

## Configuration

Every field accepted by `MapleBrowser.init`:

| Option                                 | Type                       | Default                    | Description                                                                                                                                                                                       |
| -------------------------------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestKey`                            | `string`                   | none                       | Public ingest key (`maple_pk_...`), used only as the `Authorization` header. Omit it behind a proxy that adds auth; see [Auth via a proxy](#auth-via-a-proxy).                                    |
| `serviceName`                          | `string`                   | none                       | **Required.** Service name reported on traces and stored on replay sessions.                                                                                                                      |
| `region`                               | `"us" \| "eu"`             | `"us"`                     | Region your Maple organization lives in. Ignored when `endpoint` is set. See [Regions](#regions).                                                                                                  |
| `endpoint`                             | `string`                   | `https://ingest.maple.dev` | Maple ingest base URL. Overrides `region`. Use it for a proxy or self-hosted ingest.                                                                                                               |
| `serviceNamespace`                     | `string`                   | none                       | Logical group this service belongs to, emitted as the OTel `service.namespace` resource attribute on traces.                                                                                      |
| `serviceVersion`                       | `string`                   | none                       | Service version or commit SHA, attached to traces.                                                                                                                                                |
| `environment`                          | `string`                   | none                       | Deployment environment, e.g. `"production"`.                                                                                                                                                      |
| `user`                                 | `MapleIdentity`            | none                       | End-user identity attached to sessions and browser spans. Same shape as the `identify()` object. See [Identifying users](#identifying-users).                                                     |
| `userId`                               | `string`                   | none                       | **Deprecated**, use `user`. User id attached to the replay session and future browser spans.                                                                                                      |
| `tracing.enabled`                      | `boolean`                  | `true`                     | Enable OTel browser tracing.                                                                                                                                                                      |
| `tracing.instrumentFetch`              | `boolean`                  | `true`                     | Auto-instrument `fetch()` to create network spans. Set `false` when another tracer (e.g. the Effect client SDK) already instruments requests. Its spans feed the session through the published sink, and turning this off avoids duplicate network spans. |
| `tracing.captureErrors`                | `boolean`                  | `true`                     | Record uncaught errors and unhandled rejections as error spans. See [Errors](#errors).                                                                                                             |
| `tracing.propagateTraceHeaderCorsUrls` | `Array<string \| RegExp>`  | `[]`                       | Cross-origin URLs whose `fetch()` requests carry the `traceparent` header. See [Tracing across origins](#tracing-across-origins).                                                                  |
| `replay.enabled`                       | `boolean`                  | `true`                     | Enable rrweb session recording.                                                                                                                                                                   |
| `replay.sampleRate`                    | `number`                   | `1`                        | Fraction of sessions to record, `0` to `1`. Out-of-range values are clamped with a warning. See [Sampling](#sampling).                                                                            |
| `privacy.maskAllInputs`                | `boolean`                  | `true`                     | Mask all `<input>` values in the recording.                                                                                                                                                       |
| `privacy.maskAllText`                  | `boolean`                  | `false`                    | Mask all text in the rrweb recording and omit captured click-target text from session events.                                                                                                     |
| `privacy.persistVisitorId`             | `boolean`                  | `true`                     | Store a persistent visitor id (localStorage + cookie) so unique visitors and new-vs-returning are measurable. Turning it off also purges any id already stored.                                   |
| `privacy.crossSubdomainCookie`         | `boolean`                  | `true`                     | Scope the visitor-id cookie to the registered domain so sibling subdomains share it. See [Linking a marketing site to your app](#linking-a-marketing-site-to-your-app).                           |
| `privacy.cookieDomain`                 | `string`                   | probed                     | Explicit cookie `Domain=` (no leading dot). `""` forces a host-only cookie.                                                                                                                       |
| `privacy.requireConsent`               | `boolean`                  | `false`                    | Capture nothing until `MapleBrowser.setConsent(true)`. See [Consent](#consent).                                                                                                                   |
| `privacy.captureUserEmail`             | `boolean`                  | `true`                     | Send `identify()`'s email through to the warehouse.                                                                                                                                               |
| `privacy.respectDoNotTrack`            | `boolean`                  | `false`                    | Treat `navigator.doNotTrack` like Global Privacy Control (suppresses the persistent visitor id).                                                                                                  |
| `privacy.sanitizeUrl`                  | `(url: string) => string`  | none                       | Rewrite every URL before it leaves the page. Runs after the built-in redaction. See [Privacy & masking](#privacy--masking).                                                                        |

A fully specified call:

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	environment: "production",
	serviceVersion: "1.4.2",
	user: { id: currentUser.id, email: currentUser.email },
	tracing: { enabled: true, instrumentFetch: true },
	replay: { enabled: true, sampleRate: 1.0 },
	privacy: { maskAllInputs: true, maskAllText: false },
})
```

### Auth via a proxy

`ingestKey` only sets the `Authorization: Bearer` header. Without it, tracing and replay still run and
send without the header. A first-party proxy (to get past ad blockers, or to keep the key out of
the bundle) can then attach the key server-side: set `endpoint` to the proxy and leave `ingestKey` out.
Keyless requests to Maple's hosted ingest cannot work (it answers 401), so that combination logs a
warning.

### Regions

Maple runs separate US and EU instances, and an ingest key only works in the region it was created
in. Set `region: "eu"` for an organization on `app.eu.maple.dev`. The SDK then sends to
`https://ingest.eu.maple.dev`. An explicit `endpoint` always wins over `region`.

## Sessions

Every span and replay event the SDK emits carries one **`session.id`** (a
`crypto.randomUUID()` v4), minted on the first `MapleBrowser.init` call. That shared id is
what lets a trace jump to the replay that produced it, and the reverse.

### Storage & continuity

The session is persisted in `sessionStorage` under the key `maple.session`, so it **survives
reloads within a tab**. `sessionStorage` is per-tab, so **each tab or window gets its own
session**. Sessions are never shared across them. When `sessionStorage` is unavailable (e.g.
some private-browsing modes), the SDK falls back to an in-memory record for the life of the
page.

SPA route changes do **not** start a new session. The SDK tracks no router events, so
client-side navigation stays within the same session. Session boundaries are purely
time-based (see below).

### Rotation

A fresh `session.id` is minted when either limit is crossed, whichever comes first:

- **30 minutes idle**: no recorded activity for half an hour rotates the session (the same
  activity-window model PostHog uses).
- **24 hours old**: a hard cap on a single session's lifetime regardless of activity, so a
  tab left open for days doesn't collapse into one giant replay.

While replay is recording, each flushed chunk marks the session active and pushes back the idle
deadline, so a continuously recording session stays whole.

### Start & end metadata

The SDK writes a small session-metadata row at these points:

- an **`active`** row when recording starts (and again on each reload);
- a heartbeat row every 60s, so exit page, page views and duration survive a tab killed without an
  unload event;
- an **`ended`** row on page hide or unload, fired on `visibilitychange → hidden` (the
  reliable "leaving" signal on mobile) and `pagehide` (desktop tab close or navigation).

The `ended` row carries the session duration, the click count, and the **trace ids observed
during the session**. Those ids power trace↔replay correlation and the user/session
columns in Maple's session list and detail views. The unload write uses `keepalive`, so it
survives the page going away.

### Accessing the session id

`init()` returns a handle whose `sessionId` is the active session's id. Use it to
correlate Maple sessions with your own backend logs:

```ts
const { sessionId } = MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
})

// e.g. forward it on your own requests for correlation
fetch("/api/checkout", { headers: { "x-maple-session": sessionId } })
```

`init()` is idempotent: calling it again returns the same live handle. On the server (SSR, or
no `window`) it returns a no-op handle with an empty `sessionId`.

### Teardown

Call `shutdown()` to flush the final replay chunk and tear down tracing and replay. After it
resolves, telemetry is fully stopped and a later `init()` may start a new session. This is useful
when a single-page app unmounts its telemetry client:

```ts
const maple = MapleBrowser.init({ ingestKey: "maple_pk_...", serviceName: "acme-web" })

// later, on teardown
await maple.shutdown()
```

## Identifying users

Pass `user` (or the deprecated `userId`) so replays and traces are tied to a known user. It fills the user column in the Maple session list and detail views, and browser-created spans include `user.id`.

If you don't know the user at init time (e.g. the SDK starts before login resolves), omit it and the session begins anonymous. Once you know who the user is, call `MapleBrowser.identify(userId)` to attach (or replace) the id on the active session. `identify()` is also safe to call before `init()`; the latest call is applied when `init()` runs. Future session rows read the latest id when they post, and future spans read it when they start.

```ts
// after the user signs in
MapleBrowser.identify(user.id)

// after the user signs out
MapleBrowser.identify(null)
```

`identify()` also takes an object. It fills the rest of the session's identity columns: the email
and name shown on the session, and the company or team the Sessions UI can group by:

```ts
MapleBrowser.identify({
	id: "user_123",
	email: "ada@acme.com",
	username: "ada",
	groupId: "org_42",
	groupName: "Acme",
	traits: { plan: "pro", signup_month: "2026-01" },
})
```

Each call **replaces** the identity instead of merging it. Merging would leak a signed-out user's
email into whoever signs in next on a shared device. Traits are capped (24 keys, 64-char keys,
256-char values) and the identity is never persisted to storage.

## Custom events

`track(name, props)` records a product event against the current session. It lands as a
`session_events` row with `Type='custom'`, so it appears inline in the session transcript next to the
clicks and network calls around it instead of in a separate analytics silo.

```ts
MapleBrowser.track("checkout_completed", { plan: "pro", seats: 12 })
```

Names are capped at 128 chars; props at 32 keys / 64-char keys / 1024-char values / 8KB total.
Values are coerced to strings (`Date` → ISO, objects → JSON; `null`/`undefined`/functions are
dropped). Calls before `init()` finishes are queued, and `track()` never throws.

## Errors

Every uncaught error and unhandled rejection becomes a span with status `Error` and an `exception`
event, the shape Maple fingerprints. Browser crashes group beside your server-side errors.

Errors your app catches never reach the global handlers. Report those with `captureException`
(a framework error boundary is the typical caller). The same error object is recorded once, even if
it is rethrown afterwards:

```ts
try {
	render()
} catch (error) {
	MapleBrowser.captureException(error, { name: "browser.render_error" })
}
```

The span name defaults to `"exception"`; `attributes` adds extra span attributes. Turn the global
handlers off with `tracing: { captureErrors: false }` only when another tracker already owns them
and the same crash would be recorded twice.

Cross-origin scripts report a bare `"Script error."` with no stack or filename. The SDK drops those,
since they all fingerprint to one empty issue. Add `crossorigin` to the script tag to get the real
error.

## Tracing across origins

`fetch` spans send the W3C `traceparent` header to same-origin requests only. When your API lives
on another origin, list it so browser and backend spans join one trace, and allow the `traceparent`
header in the API's CORS policy:

```ts
MapleBrowser.init({
	// ...
	tracing: { propagateTraceHeaderCorsUrls: [/^https:\/\/api\.example\.com\//] },
})
```

## Linking a marketing site to your app

The visitor id is stored in **both** localStorage and a cookie scoped to your registered domain, so
`example.com` and `app.example.com` resolve to the same `VisitorId`. Initialize the SDK on both and
an anonymous visit links to the signed-in sessions it later becomes. Filter the Sessions list by
visitor id to see the whole journey.

The **session** id is deliberately not shared: each origin keeps its own session, and `VisitorId` is
the join key between them.

The cookie domain is discovered by probing (no public-suffix list needed). Override it when the
default is wrong:

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

Capture is ungated by default. Set `privacy.requireConsent` to hold everything until the user
agrees, then flip it with `setConsent()`:

```ts
MapleBrowser.init({ ingestKey, serviceName, privacy: { requireConsent: true } })

// once the banner is accepted
MapleBrowser.setConsent(true)
```

Revoking stops capture without flushing, and a later grant starts a fresh session. Global Privacy
Control is honored regardless of `requireConsent`. It suppresses the persistent visitor id (the one
cross-session identifier the SDK stores) and leaves session-scoped capture alone. `doNotTrack` is
ignored unless you set `privacy.respectDoNotTrack`. `privacy.persistVisitorId: false` turns the
visitor id off entirely and purges any id already stored. `privacy.captureUserEmail: false` keeps
`identify()`'s email out of the warehouse.

## Privacy & masking

`maskAllInputs` is **on by default**, so every `<input>` value is masked before it leaves the browser. Set `maskAllText: true` to also mask all rendered text.

For finer control, use rrweb's attribute hooks to block specific elements or subtrees from capture:

- `data-rr-block` attribute, or the `.rr-block` class: block an element and its subtree (rendered as a placeholder).
- `.rr-ignore` class: ignore input events on an element.

```html
<div class="rr-block">
	<!-- never captured in the replay -->
	<CreditCardForm />
</div>
```

URLs are redacted before they leave the page. The values of credential-shaped query and fragment
parameters (`token`, `code`, `access_token`, `password`, ...) become `REDACTED` in session rows,
events, network events, replay meta events and span attributes. Add your own rewriting with
`privacy.sanitizeUrl`, e.g. to collapse ids in paths:

```ts
privacy: {
	sanitizeUrl: (url) => url.replace(/\/users\/\d+/, "/users/:id")
}
```

## Sampling

To record only a fraction of sessions, set `replay.sampleRate` between `0` and `1`. For example, `0.1` records ~10% of sessions. Tracing is unaffected by this setting.

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	replay: { sampleRate: 0.1 },
})
```

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

### React / Vite / Next.js

Initialize at the top of your client entrypoint (e.g. `main.tsx`, or a client-only module) so it runs once before the app renders:

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

In Next.js, run the import from a client component mounted high in the tree (e.g. the root layout), since the SDK is browser-only.

## Notes

- Replay event blobs live in object storage. Only small, queryable metadata is indexed, and playback streams blobs directly via signed URLs.
- The SDK is browser-only and best-effort: telemetry network failures never surface to your application.

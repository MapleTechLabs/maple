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

- starts OTel browser tracing, auto-instrumenting `fetch` and `XMLHttpRequest` and exporting to Maple's ingest (`POST /v1/traces`);
- captures uncaught errors and unhandled promise rejections as error spans (see [Errors](#errors));
- records the session with rrweb, chunks events into ~5s / 100KB windows, gzips them with the native `CompressionStream`, and uploads them to `POST /v1/sessionReplays/blob`;
- writes session metadata to `POST /v1/sessionReplays/meta`: an `active` row at start, a heartbeat every 60s, and an `ended` row on page hide, which includes the trace ids observed during the session.

The SDK is **best-effort**: network failures in telemetry never throw into your app.

`init()` returns a handle, `{ sessionId, shutdown }`, for reading the active session id and tearing telemetry down. See [Sessions](#sessions).

## Configuration

Every field accepted by `MapleBrowser.init`:

| Option                                 | Type                      | Default                                   | Description                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestKey`                            | `string`                  | none                                      | Public ingest key (`maple_pk_...`), used only as the `Authorization` header. Omit it behind a proxy that adds auth; see [Auth via a proxy](#auth-via-a-proxy).                                                                                            |
| `serviceName`                          | `string`                  | none                                      | **Required.** Service name reported on traces and stored on replay sessions.                                                                                                                                                                              |
| `region`                               | `"us" \| "eu"`            | `"us"`                                    | Region your Maple organization lives in. Ignored when `endpoint` is set. See [Regions](#regions).                                                                                                                                                         |
| `endpoint`                             | `string`                  | `https://ingest.maple.dev`                | Maple ingest base URL. Overrides `region`. Use it for a proxy or self-hosted ingest.                                                                                                                                                                      |
| `serviceNamespace`                     | `string`                  | none                                      | Logical group this service belongs to, emitted as the OTel `service.namespace` resource attribute on traces.                                                                                                                                              |
| `serviceVersion`                       | `string`                  | none                                      | Service version or commit SHA, attached to traces.                                                                                                                                                                                                        |
| `environment`                          | `string`                  | none                                      | Deployment environment, e.g. `"production"`.                                                                                                                                                                                                              |
| `user`                                 | `MapleIdentity`           | none                                      | End-user identity attached to sessions and browser spans. Same shape as the `identify()` object. See [Identifying users](#identifying-users).                                                                                                             |
| `userId`                               | `string`                  | none                                      | **Deprecated**, use `user`. User id attached to the replay session and future browser spans.                                                                                                                                                              |
| `tracing.enabled`                      | `boolean`                 | `true`                                    | Enable OTel browser tracing.                                                                                                                                                                                                                              |
| `tracing.instrumentFetch`              | `boolean`                 | `true`                                    | Auto-instrument `fetch()` to create network spans. Set `false` when another tracer (e.g. the Effect client SDK) already instruments requests. Its spans feed the session through the published sink, and turning this off avoids duplicate network spans. |
| `tracing.instrumentXhr`                | `boolean`                 | `true`                                    | Auto-instrument `XMLHttpRequest` (axios and older clients) like `fetch`.                                                                                                                                                                                  |
| `tracing.captureErrors`                | `boolean`                 | `true`                                    | Record uncaught errors and unhandled rejections as error spans. See [Errors](#errors).                                                                                                                                                                    |
| `tracing.propagateTraceHeaderCorsUrls` | `Array<string \| RegExp>` | `[]`                                      | Cross-origin URLs whose `fetch()` and XHR requests carry the `traceparent` header. See [Tracing across origins](#tracing-across-origins).                                                                                                                 |
| `tracing.sampleRate`                   | `number`                  | `1`                                       | Fraction of sessions whose traces are exported, `0` to `1`. Decided per session; reported errors are always exported. See [Sampling](#sampling).                                                                                                          |
| `webVitals`                            | `boolean`                 | `true`                                    | Report Core Web Vitals as `browser.web_vital` log events. See [Web Vitals](#web-vitals).                                                                                                                                                                  |
| `breadcrumbs`                          | `boolean`                 | `true`                                    | Keep the last clicks, inputs, navigations and console lines, and export them with the next error. See [Breadcrumbs](#breadcrumbs).                                                                                                                        |
| `logs.captureConsole`                  | `ConsoleLevel[]`          | `[]`                                      | Console levels exported as OTel logs as they happen, e.g. `["warn", "error"]`.                                                                                                                                                                            |
| `reporting.csp`                        | `boolean`                 | `true`                                    | Content Security Policy violations as `maple.browser.csp_violation` WARN logs. See [Browser reports](#browser-reports).                                                                                                                                   |
| `reporting.browserReports`             | `boolean`                 | `false`                                   | Browser deprecation and intervention reports as `maple.browser.report` WARN logs.                                                                                                                                                                         |
| `errors`                               | `ErrorFilterOptions`      | see [Filtering errors](#filtering-errors) | Drop captured errors by message, script URL, or a `beforeCapture` hook.                                                                                                                                                                                   |
| `replay.enabled`                       | `boolean`                 | `true`                                    | Enable rrweb session recording.                                                                                                                                                                                                                           |
| `replay.sampleRate`                    | `number`                  | `1`                                       | Fraction of sessions to record, `0` to `1`. Out-of-range values are clamped with a warning. See [Sampling](#sampling).                                                                                                                                    |
| `tracing.longFrames`                   | `boolean`                 | `false`                                   | Span main-thread frames of 100ms or more. See [Jank](#jank).                                                                                                                                                                                              |
| `tracing.slowInteractions`             | `boolean`                 | `false`                                   | Span interactions of 200ms or more. See [Jank](#jank).                                                                                                                                                                                                    |
| `tracing.captureHeaders`               | `{ request?, response? }` | none                                      | Header names recorded on `fetch`/XHR spans as `http.request.header.<name>` / `http.response.header.<name>`. See [Request and response detail](#request-and-response-detail).                                                                              |
| `replay.canvasFps`                     | `number`                  | off                                       | Record `<canvas>` content at this many frames per second.                                                                                                                                                                                                 |
| `replay.networkBodies`                 | `{ urls, maxLength? }`    | none                                      | Keep text response bodies of these URLs on replay network events, and request bodies too with `privacy.maskAllInputs: false`.                                                                                                                             |
| `replay.onErrorSampleRate`             | `number`                  | `0`                                       | Fraction of the sessions not recorded that buffer the last minute in memory and keep it only if an error happens. See [Sampling](#sampling).                                                                                                              |
| `transport.offline`                    | `boolean`                 | `false`                                   | Keep span and log batches that could not be sent in IndexedDB for up to 24 hours and send them later. See [Offline](#offline).                                                                                                                            |
| `privacy.maskAllInputs`                | `boolean`                 | `true`                                    | Mask all `<input>` values in the recording.                                                                                                                                                                                                               |
| `privacy.maskAllText`                  | `boolean`                 | `false`                                   | Mask all text in the rrweb recording and omit captured click-target text from session events.                                                                                                                                                             |
| `privacy.persistVisitorId`             | `boolean`                 | `true`                                    | Store a persistent visitor id (localStorage + cookie) so unique visitors and new-vs-returning are measurable. Turning it off also purges any id already stored.                                                                                           |
| `privacy.crossSubdomainCookie`         | `boolean`                 | `true`                                    | Scope the visitor-id cookie to the registered domain so sibling subdomains share it. See [Linking a marketing site to your app](#linking-a-marketing-site-to-your-app).                                                                                   |
| `privacy.cookieDomain`                 | `string`                  | probed                                    | Explicit cookie `Domain=` (no leading dot). `""` forces a host-only cookie.                                                                                                                                                                               |
| `privacy.requireConsent`               | `boolean`                 | `false`                                   | Capture nothing until `MapleBrowser.setConsent(true)`. See [Consent](#consent).                                                                                                                                                                           |
| `privacy.captureUserEmail`             | `boolean`                 | `true`                                    | Send `identify()`'s email through to the warehouse.                                                                                                                                                                                                       |
| `privacy.respectDoNotTrack`            | `boolean`                 | `false`                                   | Treat `navigator.doNotTrack` like Global Privacy Control (suppresses the persistent visitor id).                                                                                                                                                          |
| `privacy.sanitizeUrl`                  | `(url: string) => string` | none                                      | Rewrite every URL before it leaves the page. Runs after the built-in redaction. See [Privacy & masking](#privacy--masking).                                                                                                                               |

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

SPA route changes do **not** start a new session: navigation spans (see
[React integration](#react-integration)) stay within it. Session boundaries are purely
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

## Logs

`MapleBrowser.logger` writes OpenTelemetry log records. Each one is linked to the span active when
it was logged and carries `session.id` (and `user.id` once known), so it shows up on the trace, in
the logs explorer, and next to the session.

```ts
MapleBrowser.logger.info("checkout started", { "cart.items": 3 })
MapleBrowser.logger.error("payment declined", { "payment.provider": "card" })
```

Levels are `debug`, `info`, `warn` and `error`. Attribute values are strings, numbers or booleans.
Calls before `init()` are queued. The logs SDK loads in a separate chunk right after `init()`, so it
stays out of the bundle every page load has to parse first.

## Filtering errors

Filters run before an error span exists, so a dropped error costs nothing and never becomes an
issue. They apply to the global handlers and to `captureException`.

```ts
MapleBrowser.init({
	// ...
	errors: {
		ignore: ["ChunkLoadError", /^AbortError: /], // matched against "Name: message"
		denyUrls: [/widgets\.example\.net/], // matched against the top frame's script URL
		allowUrls: [/^https:\/\/app\.example\.com\//], // errors with no frames are kept
		beforeCapture: (error, { source, originalError }) => !error.message.includes("401"),
	},
})
```

Errors thrown from browser extensions (`chrome-extension://`, `moz-extension://`,
`safari-web-extension://`) and the benign `ResizeObserver loop` notices are dropped by default. Set
`errors.defaultFilters: false` to keep them.

### Failed HTTP requests

`fetch` and `XMLHttpRequest` spans follow the HTTP semantic conventions for client spans: a 4xx or
5xx response makes the span `Error`, with `error.type` set to the status code (`"404"`, `"503"`)
and no status description, so it opens an issue. Issues group by service and status code.

To count fewer statuses, narrow `errors.captureHttpStatus` (default `[[400, 599]]`). A status left
out has its `Error` cleared:

```ts
MapleBrowser.init({
	// ...
	errors: { captureHttpStatus: [[500, 599], 429] }, // a 404 from a search box is expected here
})
```

Network failures (no response at all: offline, DNS, CORS, or a timeout, including one from `AbortSignal.timeout()`) are always errors, with
`error.type` set to what failed (`TypeError` for `fetch`, `error` or `timeout` for XHR). A request your code
aborts with its own `AbortController` is not. No `error.message` is set: it is deprecated in the conventions, and the status
code already says what went wrong.

### Breadcrumbs

The SDK keeps the last 50 clicks, inputs, navigations and console lines in memory. Nothing is sent
until an error is recorded: then the trail is exported as OpenTelemetry log records linked to the
error's span, so it shows up on the error's trace. Each breadcrumb is sent once; the next error gets
the trail since the last one.

- Clicks, inputs and navigations are `maple.browser.breadcrumb` events with `maple.breadcrumb.type`,
  `maple.breadcrumb.target` (a short selector, never an input value) and `url.full`.
- Console lines are ordinary log records at the console call's severity, with
  `maple.breadcrumb.type: "console"`.

Collection starts with the SDK's deferred chunk, a moment after `init()`. Turn it off with
`breadcrumbs: false`. To send console output as logs whether or not an error follows, list the
levels in `logs.captureConsole`; those lines are exported right away and not kept as breadcrumbs.

### Linked errors

`error.cause` chains and the members of an `AggregateError` (up to five linked errors) are appended
to `exception.stacktrace` as `Caused by:` blocks after the error's own frames. Issues are
fingerprinted on the top frames, so adding a cause does not split an existing issue unless the
error's own stack has fewer than three frames.

## Page load timing

When your router calls `MapleBrowser.startNavigation` (see the package README), the first call opens
a `pageload` span that starts at the browser's navigation start, not when your JavaScript got to
run. Once the page has loaded, the SDK adds child spans from the Navigation Timing entry:

| Span            | Covers                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| `documentFetch` | fetching the HTML, with `dns`, `connect`, `request` and `response` under it |
| `domProcessing` | the response end until the DOM is complete                                  |
| `loadEvent`     | the page's `load` handlers                                                  |

Phases that didn't happen (a reused connection has no `dns` or `connect`) are skipped.

## Web Vitals

LCP, CLS, INP, FCP and TTFB are reported with the `web-vitals` library, each as an OpenTelemetry
log-based event named `browser.web_vital`, following the browser semantic conventions:

| Attribute                           | Example                          |
| ----------------------------------- | -------------------------------- |
| `browser.web_vital.name`            | `lcp`                            |
| `browser.web_vital.value`           | `1830.4` (ms; CLS is unitless)   |
| `browser.web_vital.delta`           | `1830.4`                         |
| `browser.web_vital.id`              | `v5-1727600000000-1234567890123` |
| `browser.web_vital.rating`          | `good`                           |
| `browser.web_vital.navigation_type` | `navigate`                       |
| `url.path`                          | `/projects/42`                   |

Each event carries `session.id` and is linked to the page's `pageload` span when your router calls
`startNavigation`. CLS, INP and LCP settle when the page is hidden, so they arrive then. Turn them off
with `webVitals: false`.

## Browser reports

Content Security Policy violations are reported as `maple.browser.csp_violation` WARN log events with
`maple.csp.effective_directive`, `maple.csp.blocked_uri`, `maple.csp.disposition`, `url.full` and,
when the browser knows it, `code.file.path` / `code.line.number`. Set `reporting.browserReports: true`
to also get deprecation and intervention reports as `maple.browser.report` events. Both are logs,
not errors, so they never open an issue.

Each kind of report is sent once per page (a blocked image in a loop is one report), up to 50 kinds.
Where the browser supports `ReportingObserver`, reports from before the SDK loaded are included.

## Tracing across origins

`fetch` and `XMLHttpRequest` spans send the W3C `traceparent` header to same-origin requests only. When your API lives
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

### Replay on error

`replay.onErrorSampleRate` covers the sessions `replay.sampleRate` leaves out. Those sessions run
the recorder into memory only, keeping roughly the last minute (the segments since the
second-to-last full snapshot, taken every 30s while the page is visible and changing). Nothing is uploaded. When an error is recorded (an
uncaught error, an unhandled rejection or `captureException`, after [filters](#filtering-errors)),
the buffered minute is uploaded and the rest of the session is recorded normally, including its
later page loads. The session is marked `maple.session.replay_trigger: "error"`, and its replay starts
up to a minute before the error rather than at the start of the session.

```ts
MapleBrowser.init({
	// ...
	replay: { sampleRate: 0.05, onErrorSampleRate: 1 }, // 5% of sessions, plus every session with an error
})
```

Buffered sessions download the replay chunk like recorded ones, and keep up to 4 MB of events in
memory.

`tracing.sampleRate` does the same for traces. The decision is made once per session (a hash of
`session.id`), so a sampled session keeps every one of its traces and its replay never links to a
dropped one. Errors reported as their own spans (uncaught errors, unhandled rejections and
`captureException`) are always exported, whatever the rate; request spans of an unsampled session
are not, including failed requests.

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	tracing: { sampleRate: 0.25 },
	replay: { sampleRate: 0.1 },
})
```

Sampled traces carry the W3C `tracestate` threshold (`ot=th:…`), so Maple weights each one by the
inverse of the rate and request counts stay realistic. A trace joined from a server-rendered
`traceparent` follows the server's decision instead.

## Jank

Two opt-in span sources show where the main thread got stuck:

```ts
tracing: { longFrames: true, slowInteractions: true }
```

- `longFrames` spans every frame of 100ms or more as `longAnimationFrame`, with the script that ran
  longest as `code.file.path` / `code.function.name`, its `maple.browser.script.invoker` (e.g.
  `BUTTON#save.onclick`) and `maple.browser.script.duration_ms`, plus
  `maple.browser.frame.blocking_duration_ms`. Browsers without the Long Animation Frames API report
  `longtask` spans instead, without script attribution.
- `slowInteractions` spans every interaction of 200ms or more (INP's "needs improvement" line) as
  `interaction <event>`, named after the event whose handlers ran longest, with
  `maple.browser.interaction.input_delay_ms`, `processing_ms`, `presentation_ms` and `target`.

Both nest under the open navigation span when there is one, include what happened before the SDK
finished loading, and follow `tracing.sampleRate`.

## Request and response detail

Headers go on the spans, as the HTTP semantic conventions define them. List the ones you want:

```ts
MapleBrowser.init({
	// ...
	tracing: { captureHeaders: { request: ["x-request-id"], response: ["x-cache", "server-timing"] } },
})
```

Each becomes a string-array attribute, e.g. `http.response.header.x-cache: ["HIT"]`.
`authorization`, `proxy-authorization`, `cookie` and `set-cookie` are never recorded, even when
listed. XHR spans get response headers only (the browser does not expose an XHR's request headers),
and a cross-origin response only exposes the headers its server lists in
`Access-Control-Expose-Headers`.

Bodies have no semantic-convention attribute, so they stay on the session replay's network events,
and only for the URLs you list:

```ts
replay: {
	networkBodies: {
		urls: [/^https:\/\/api\.example\.com\/checkout/]
	}
}
```

Patterns match the full URL, so a relative `fetch("/api/checkout")` is matched as
`https://your.app/api/checkout`. Only text and JSON bodies are kept, each cut to `maxLength` characters (at most and by default 1,000: ingest stores up to 1 KB per body). The response is read from a
clone in the background, only as far as `maxLength` and for at most 5 seconds, so your code gets it untouched and unwaited;
event streams (`text/event-stream`) are never read. Nothing is captured with `privacy.maskAllText`, and
request bodies only with `privacy.maskAllInputs: false`, since a form POST carries what was typed. Only
string request bodies are kept (not `FormData`, `Blob` or a stream). Bodies can hold personal data: list
only endpoints whose payloads you are allowed to record.

### Canvas

`replay: { canvasFps: 2 }` records `<canvas>` content (charts, maps, games) as WebP frames at up to
that rate. It costs CPU and upload size, so it is off by default. It is never recorded with
`privacy.maskAllText`, since text drawn into a canvas cannot be masked.

## Offline

The OTLP exporters already retry a failed export a few times (about 10 seconds in all). With
`transport: { offline: true }`, a batch that still fails (the browser is offline, or ingest is
down) is kept in IndexedDB, as the same OTLP JSON the exporter sends, and sent again when the
browser fires `online` and on the next page load. Batches older than 24 hours are dropped, and at
most 100 are kept. Revoking consent clears the queue, in every tab; with `privacy.requireConsent`,
batches from an earlier page are still sent once consent is granted again, unless it was revoked in between. Where IndexedDB is unavailable (some private
windows), nothing is kept.

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

### React integration

`@maple-dev/browser/react` adds an error boundary, a React 19 root error handler, and adapters that
span navigations straight from your router. `react` is an optional peer dependency; routers are
typed structurally, so no router package is required.

```tsx
import { createBrowserRouter, RouterProvider } from "react-router"
import { instrumentReactRouter, mapleReactErrorHandler, MapleErrorBoundary } from "@maple-dev/browser/react"

const router = createBrowserRouter(routes)
instrumentReactRouter(router)

createRoot(document.getElementById("root")!, {
	onCaughtError: mapleReactErrorHandler(),
	onUncaughtError: mapleReactErrorHandler(),
}).render(
	<MapleErrorBoundary fallback={({ reset }) => <button onClick={reset}>Try again</button>}>
		<RouterProvider router={router} />
	</MapleErrorBoundary>,
)
```

- `MapleErrorBoundary` reports a render error once (as a `react.render_error` span with the
  component stack in `maple.react.component_stack`) and renders `fallback`, which may be a node or a
  function of `{ error, reset }`.
- `mapleReactErrorHandler()` fits React 19's `onCaughtError`, `onUncaughtError` and
  `onRecoverableError` root options. An error already reported by a boundary is not reported again.
- `instrumentReactRouter(router)` takes a data router (`createBrowserRouter` and friends). A
  navigation starts when the router starts loading and ends when its loaders settle, named by the
  route template (`navigate /projects/:id`). The first is the `pageload`.
- `instrumentTanStackRouter(router)` does the same from `onBeforeNavigate` to `onResolved`, named by
  the leaf route's full path (`navigate /projects/$projectId`). Search-only changes are not
  navigations.

Both adapters return an unsubscribe. Attach them after `MapleBrowser.init`, or the page load is
missed, and don't also call `startNavigation`/`endNavigation` yourself.

## Notes

- Replay event blobs live in object storage. Only small, queryable metadata is indexed, and playback streams blobs directly via signed URLs.
- The SDK is browser-only and best-effort: telemetry network failures never surface to your application.

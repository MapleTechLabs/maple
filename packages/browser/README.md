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

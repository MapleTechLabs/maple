---
title: "Effect SDK in the browser"
description: "Set up the Effect SDK in browser environments with explicit configuration and auto-captured browser metadata."
group: "Instrumentation"
order: 3
navLabel: "Browser"
sdk: "effect"
---

The browser entry point of `@maple-dev/effect-sdk` runs in single-page apps and any other browser context. [Install the SDK](/docs/sdks/effect#install) first. Unlike the server build, it reads no environment variables: browsers have no `process.env`, so all configuration is passed to `Maple.layer()`.

## Quick start

```typescript
import { Maple } from "@maple-dev/effect-sdk/client"
import { Effect } from "effect"

const TracerLive = Maple.layer({
	serviceName: "my-frontend",
	ingestKey: "maple_pk_...",
	region: "eu", // omit for the US region
})

const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

`serviceName` is the only required option. Without `endpoint`, the layer sends to the ingest for `region`: `https://ingest.maple.dev` for `"us"` (the default) or `https://ingest.eu.maple.dev` for `"eu"`. Set `endpoint` only for a proxy or [Maple Local](/docs/local-mode); it overrides `region`.

Import from `/client` explicitly. Bundlers that apply the `node` export condition, such as the server side of a framework build, resolve the bare `@maple-dev/effect-sdk` import to the server build.

## Auto-captured browser attributes

The client layer reads `globalThis.navigator` and `Intl.DateTimeFormat` to fill in resource attributes:

- `user_agent.original`: `navigator.userAgent`
- `browser.language`: `navigator.language`
- `maple.browser.timezone`: `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `maple.sdk.type`: always `"client"`, so server and browser spans can be filtered apart
- `telemetry.sdk.name`, `telemetry.sdk.language` (`webjs`) and `telemetry.sdk.version`

Attributes you pass in the `attributes` option are merged on top of these.

## Session replay and sessions

The browser presets (`Maple.layer` and `MapleFlush.make`) record **rrweb session replays by default**, without a separate browser SDK. Every span carries a `session.id`, the session appears on the [Replays](/docs/session-replay/replays) page with its linked traces, and the recording plays back next to them.

```typescript
const TracerLive = Maple.layer({
	serviceName: "my-frontend",
	ingestKey: "maple_pk_...",
	replay: {
		sampleRate: 0.1, // record 10% of sessions (default 1)
	},
})
```

| Option                 | Default | Description                                                                                             |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `replay.enabled`       | `true`  | Record rrweb session replays.                                                                           |
| `replay.sampleRate`    | `1`     | Fraction of sessions to record, 0 to 1.                                                                 |
| `replay.maskAllInputs` | `true`  | Mask all `<input>` values in the recording.                                                             |
| `replay.maskAllText`   | `false` | Mask all text in the recording.                                                                         |
| `replay.canvasFps`     |         | Record `<canvas>` content at this many frames per second. Off when unset, and never with `maskAllText`. |
| `emitSessionMeta`      | `true`  | Post session metadata rows so unrecorded sessions still appear on the Replays page.                     |

How it behaves:

- **Sampling still yields sessions.** When replay is disabled or a session isn't sampled, the SDK still posts session metadata rows. The session shows up on the Replays page with its linked traces, just without a recording. Set `emitSessionMeta: false` to turn that off too.
- **Tab lifecycle.** Recording suspends when the tab is hidden (flushing the tail with `keepalive`) and resumes when it becomes visible again. Sessions survive reloads within a tab and rotate after 30 minutes of inactivity (24-hour hard cap).
- **Identify users** at any point; the id is attached when the session's next metadata row is posted and stamped as `user.id` on future spans. Pass `null` or `undefined` after sign-out to make future telemetry anonymous again:

```typescript
import { identify } from "@maple-dev/effect-sdk/client"

identify(user.id)
identify(null)
```

- **Clear the identity** on logout with `clearIdentity()` (the explicit inverse of `identify()`); metadata rows and spans go back to anonymous while the session continues:

```typescript
import { clearIdentity } from "@maple-dev/effect-sdk/client"

clearIdentity()
```

- **Interop with `@maple-dev/browser`.** If the standalone browser SDK is also on the page, it owns the session. This SDK's recorder and row emission stand down automatically, and spans link to that session instead. Run replay from one SDK, not both.

## Privacy

The `privacy` option controls consent, the persistent visitor id and what identity data is sent:

| Option                         | Default     | Description                                                                                                                                                                         |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privacy.requireConsent`       | `false`     | Capture nothing until `setConsent(true)` is called                                                                                                                                  |
| `privacy.persistVisitorId`     | `true`      | Store a persistent visitor id                                                                                                                                                       |
| `privacy.persistence`          | `"browser"` | `"memory"` stores nothing on the device (no cookies, Web Storage or IndexedDB, no visitor id). Each page load is a new session                                                      |
| `privacy.crossSubdomainCookie` | `true`      | Scope the visitor-id cookie to the registered domain, so sibling subdomains share one visitor                                                                                       |
| `privacy.cookieDomain`         |             | Explicit cookie `Domain` (without the leading dot). `""` forces a host-only cookie                                                                                                  |
| `privacy.captureUserEmail`     | `true`      | Send the email passed to `identify()`                                                                                                                                               |
| `privacy.respectDoNotTrack`    | `false`     | Treat `navigator.doNotTrack` like Global Privacy Control                                                                                                                            |
| `privacy.sanitizeUrl`          |             | Function that rewrites every URL before it leaves the page. Runs after the built-in redaction of credential-shaped query and fragment parameters such as `token` and `access_token` |

Global Privacy Control is honored by default: when the browser sends it, the SDK does not store the persistent visitor id. Capture itself continues without it.

With `requireConsent: true`, grant or revoke consent from your consent banner:

```typescript
import { setConsent } from "@maple-dev/effect-sdk/client"

setConsent(true)
```

With `requireConsent`, `Maple.layer` does not export metrics, because it cannot separate values recorded before consent was granted. Use [`MapleFlush.make`](#mapleflushmake) if you need browser metrics after consent.

## MapleFlush.make

`MapleFlush.make` is the buffered browser preset. It keeps spans, logs and metrics in memory and sends them on a timer, on demand with `flush()`, and before the tab goes away. It returns the layer together with the controls:

```typescript
import { MapleFlush } from "@maple-dev/effect-sdk/client"
import { Effect } from "effect"

const telemetry = MapleFlush.make({
	serviceName: "my-frontend",
	ingestKey: "maple_pk_...",
})

Effect.runPromise(program.pipe(Effect.provide(telemetry.layer)))
await telemetry.flush()
```

It takes `serviceName`, `region`, `endpoint`, `ingestKey`, `serviceVersion`, `serviceNamespace`, `environment`, `attributes`, `excludeLogSpans`, `replay`, `emitSessionMeta` and `privacy` as `Maple.layer` does, the span filters (`dropSpanNames`, `dropSpanSubtrees`, `dropSpan`, `anticipatedErrorTags`, `anticipatedErrorIdentifiers`, `isAnticipatedError`), and these options of its own:

| Option                | Default       | Description                                                                                                 |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `autoFlushInterval`   | `5000`        | Background flush cadence in ms. `0` or `false` flushes only on demand; the buffer holds up to 10,000 items. |
| `flushOnUnload`       | `true`        | Flush on `pagehide` and when the tab becomes hidden.                                                        |
| `captureGlobalErrors` | `true`        | Record uncaught errors and unhandled promise rejections from the page as error spans.                       |
| `tracesPath`          | `/v1/traces`  | OTLP traces path appended to `endpoint`.                                                                    |
| `logsPath`            | `/v1/logs`    | OTLP logs path appended to `endpoint`.                                                                      |
| `metricsPath`         | `/v1/metrics` | OTLP metrics path appended to `endpoint`.                                                                   |

The returned object has `layer`, `flush()`, `dispose()` (removes the unload listeners, stops the timer and flushes once more) and `captureException(error)` for errors thrown outside an Effect span, such as in a React error boundary.

## Use the public ingest key

Anything in your bundle is visible to every visitor. Use the **Public key** (`maple_pk_…`) from **Settings → Ingestion**, which the page marks for browser and client-side SDKs. Never ship the private key (`maple_sk_…`) in client code. Ingest keys can only write telemetry; they cannot read data back out.

## Bundle size

The `/client` entry point leaves out the Node-only resource detector and platform helpers, so the base bundle ships the OTLP JSON exporter and Effect's tracer and logger primitives (about 13 kB). The replay engine, rrweb included, sits behind a dynamic import in a separate chunk (about 360 kB). It is only fetched when replay is enabled _and_ the session is sampled, so apps that set `replay: { enabled: false }` never download it. `effect` is a peer dependency; if your app already uses Effect on the client, the SDK adds only its own layer code.

## Configuration reference

See the full [configuration table](/docs/sdks/effect#configuration-reference) on the Effect SDK page for `Maple.layer`, and [MapleFlush.make](#mapleflushmake) for the buffered preset. In the browser, `serviceName` is required and every other option is optional.

## Verify

1. Load a page of your app that runs code inside the layer.
2. In Maple, open **Explore → Traces** and filter on your service name. The layer exports spans every 5 seconds by default.
3. With replay on, open **Explore → Replays** to see the session and its linked traces.

## Troubleshooting

- **A console warning about sending without an ingest key.** Pass `ingestKey`, or point `endpoint` at a proxy that adds the key.
- **`401` responses.** The key is wrong, or it belongs to the other region. An EU key needs `region: "eu"`.
- **Requests blocked by the browser.** Check the Network tab. Maple's ingest answers CORS preflights from any origin, so a blocked request usually means an ad blocker or a Content Security Policy without `connect-src` for the ingest host.
- **Nothing sent at all.** With `privacy.requireConsent: true`, the SDK captures nothing until `setConsent(true)` is called.

## Next steps

- [Session replays](/docs/session-replay/replays)
- [Web analytics](/docs/product-events/web-analytics)
- [Explore traces](/docs/explore/traces)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)

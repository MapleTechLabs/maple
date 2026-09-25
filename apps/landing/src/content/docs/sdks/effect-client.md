---
title: "Effect SDK in the browser"
description: "Set up the Effect SDK in browser environments with explicit configuration and auto-captured browser metadata."
group: "Instrumentation"
order: 3
navLabel: "Browser"
sdk: "effect"
---

The browser entry point of `@maple-dev/effect-sdk` runs in single-page apps and any other browser context. Unlike the server build, it reads no environment variables: browsers have no `process.env`, so all configuration is passed to `Maple.layer()`.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Browsers</span>
</div>

> Already installed the SDK? If not, see the [install instructions](/docs/sdks/effect#install).

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
- `browser.timezone`: `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `maple.sdk.type`: always `"client"`, so server and browser spans can be filtered apart

Attributes you pass in the `attributes` option are merged on top of these.

## Session replay and sessions

The browser presets (`Maple.layer` and `MapleFlush.make`) record **rrweb session replays by default**, without a separate browser SDK. Every span carries a `session.id`, the session appears in [Sessions](/docs/session-replay/browser-sdk) with its linked traces, and the recording plays back next to them.

```typescript
const TracerLive = Maple.layer({
	serviceName: "my-frontend",
	ingestKey: "maple_pk_...",
	replay: {
		sampleRate: 0.1, // record 10% of sessions (default 1)
	},
})
```

| Option                 | Default | Description                                                                        |
| ---------------------- | ------- | ---------------------------------------------------------------------------------- |
| `replay.enabled`       | `true`  | Record rrweb session replays.                                                      |
| `replay.sampleRate`    | `1`     | Fraction of sessions to record, 0 to 1.                                              |
| `replay.maskAllInputs` | `true`  | Mask all `<input>` values in the recording.                                        |
| `replay.maskAllText`   | `false` | Mask all text in the recording.                                                    |
| `emitSessionMeta`      | `true`  | Post session metadata rows so unrecorded sessions still appear in the Sessions UI. |

How it behaves:

- **Sampling still yields sessions.** When replay is disabled or a session isn't sampled, the SDK still posts session metadata rows. The session shows up in the Sessions UI with its linked traces, just without a recording. Set `emitSessionMeta: false` to turn that off too.
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

| Option                         | Default | Description                                                                                                                                                         |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privacy.requireConsent`       | `false` | Capture nothing until `setConsent(true)` is called                                                                                                                  |
| `privacy.persistVisitorId`     | `true`  | Store a persistent visitor id                                                                                                                                       |
| `privacy.crossSubdomainCookie` | `true`  | Scope the visitor-id cookie to the registered domain, so sibling subdomains share one visitor                                                                       |
| `privacy.cookieDomain`         |         | Explicit cookie `Domain` (without the leading dot). `""` forces a host-only cookie                                                                                  |
| `privacy.captureUserEmail`     | `true`  | Send the email passed to `identify()`                                                                                                                               |
| `privacy.respectDoNotTrack`    | `false` | Treat `navigator.doNotTrack` like Global Privacy Control                                                                                                            |
| `privacy.sanitizeUrl`          |         | Function that rewrites every URL before it leaves the page. Runs after the built-in redaction of credential-shaped query and fragment parameters such as `token` and `access_token` |

Global Privacy Control is honored by default: when the browser sends it, the SDK does not store the persistent visitor id. Capture itself continues without it.

With `requireConsent: true`, grant or revoke consent from your consent banner:

```typescript
import { setConsent } from "@maple-dev/effect-sdk/client"

setConsent(true)
```

With `requireConsent`, `Maple.layer` does not export metrics, because it cannot separate values recorded before consent was granted. Use `MapleFlush.make` if you need browser metrics after consent.

## Use the public ingest key

Anything in your bundle is visible to every visitor. Use the **Public key** (`maple_pk_…`) from **Settings → Ingestion**, which the page marks for browser and client-side SDKs. Never ship the private key (`maple_sk_…`) in client code. Ingest keys can only write telemetry; they cannot read data back out.

## Bundle size

The `/client` entry point leaves out the Node-only resource detector and platform helpers, so the base bundle ships the OTLP JSON exporter and Effect's tracer and logger primitives (about 13 kB). The replay engine, rrweb included, sits behind a dynamic import in a separate chunk (about 360 kB). It is only fetched when replay is enabled _and_ the session is sampled, so apps that set `replay: { enabled: false }` never download it. `effect` is a peer dependency; if your app already uses Effect on the client, the SDK adds only its own layer code.

## Configuration reference

See the full [configuration table](/docs/sdks/effect#configuration-reference) on the Effect SDK page. In the browser, `serviceName` is required and every other option is optional.

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

# @maple-dev/browser

## 0.14.1

### Patch Changes

- 82843de: Browser SDK fixes from a correctness review:

    - `tracing.sampleRate` below 1 no longer adds a `tracestate` header to cross-origin requests, so an API that allows only `traceparent` in CORS keeps working (another vendor's trace-state members, when present, are still sent). Same-origin requests still carry it, so their server spans keep their sampling weight; server spans behind a cross-origin API are now weighted 1×.
    - A string in `tracing.propagateTraceHeaderCorsUrls` is now a URL prefix (`"https://api.example.com"` covers every path on that origin). Before, it had to equal the whole request URL, so it almost never matched.
    - A fetch that got no response no longer reports `http.response.status_code: 0`; the HTTP semantic conventions leave the key off.
    - A session that rotated while the previous session's event sink was still live now counts its errors and clicks from zero, instead of hiding as many as the previous session had.
    - Effect client: the page URL and script path on uncaught-error spans are redacted like every other URL, and a standalone session keeps at most 200 trace ids so its final row still fits the unload budget.

- a8506ba: Lifecycle fixes for session replay and the flushable presets:

    - Session replay uploads one chunk at a time. A chunk is cut only after the previous one is answered, so a lost chunk can no longer leave a later stored chunk that depends on a snapshot ingest never received. A page going away still sends its last chunk at once.
    - Effect client: flushes on a hidden tab and on `pagehide` join the queue every other flush uses. They still start at once, alongside a flush already in flight, and any flush called after them now waits for them instead of running over them.
    - Effect client and server `MapleFlush`: `dispose()` now ends the preset. `flush()` calls from the moment `dispose()` starts send nothing, and what is recorded through `layer` during or after the final flush, or what that flush failed to send, is dropped. A second `dispose()` returns the first one's promise instead of flushing and stopping the session again.

## 0.14.0

### Minor Changes

- 67344e1: Move to OpenTelemetry JS 3.0 (`@opentelemetry/api` 1.10, `sdk-trace` 3.0, instrumentations 0.300). `sdk-trace-base` and `sdk-trace-web` are replaced by `@opentelemetry/sdk-trace`; the SDK still registers W3C trace context + baggage propagation and a stack context manager, so tracing behaviour is unchanged.

## 0.13.0

### Minor Changes

- 534647e: Session replay keeps the last moments of a visit. A chunk recorded as the page goes away is sent before the page is torn down when it fits the unload size limit (24 KiB), so a short visit now has a recording and a session keeps its final seconds. A larger final chunk is still kept in the tab and sent by the next page load of the site. Replay also survives a failed upload (the next chunk starts from a fresh snapshot), records without `CompressionStream`, keeps recording across a tab switch without a new full snapshot, and stops once a session hits its size cap instead of retrying on every page load.

    Privacy: hidden inputs, card-number and one-time-code fields are always masked in replays, even with `maskAllInputs: false`. Click events no longer include text from blocked (`data-rr-block`) elements, scripts or contenteditable regions. URL redaction also catches camelCase and suffixed credential names (`accessToken`, `auth_token`, `clientSecret`), credentials in the URL's userinfo, unparsable URLs and hash routes without a leading slash. Credential-looking keys are redacted from captured network bodies, and console capture honours `maskAllText`. Under `requireConsent`, a revoke purges the stored visitor id. A `setConsent(false)` on a page that never granted applies after 10 seconds unless `setConsent(true)` follows, so a consent tool that starts at "denied" does not reset the visitor.

    Reliability:
    - `init()` no longer throws on plain-http sites without `crypto.randomUUID`.
    - `identify()` accepts numeric ids.
    - `init()` right after an unfinished `shutdown()` (React StrictMode) returns a working SDK.
    - Text is never cut in the middle of an emoji, which made ingest reject whole batches.
    - The SDK stays out of `fetch`, XHR, history and console wrappers the app installs after it.
    - Session event and replay uploads retry 429 and 5xx with backoff; 401/403 stop that endpoint for the key. Session metadata rows are not retried: each one is superseded by the next.
    - `captureException` and replay-on-error work with tracing turned off.

    Also: `telemetry.sdk.*` resource attributes, a warning for a missing `serviceName`, router adapters that are safe to attach twice, `mapleReactErrorHandler` passes errors on to `console.error`, `traced` accepts a synchronous function, and `captureException` before `init` is kept.

## 0.12.0

### Minor Changes

- af2b366: Browser telemetry follows the OpenTelemetry conventions more closely. Rename these keys in saved queries, dashboards and alerts:

    - `app.navigation.interrupted` is now `maple.navigation.interrupted` (both SDKs). `app.*` belongs to the semantic conventions.
    - `browser.timezone` is now `maple.browser.timezone` (`@maple-dev/effect-sdk`). It is not a semantic-convention key.
    - An interrupted span (`@maple-dev/effect-sdk`) is still `Ok`, but carries `maple.interrupted: true` instead of a status message, `status.interrupted` and `span.label`. A status message is reserved for `Error`.

    `@maple-dev/effect-sdk` also sets `error.type` on every failed span that lacks one (`TransportError` for a request that never got a response, otherwise the error's name), and browser presets report `telemetry.sdk.name`, `telemetry.sdk.language` (`webjs`) and `telemetry.sdk.version`.

### Patch Changes

- c463f5c: Report the package's own version in the SDK hint sent to ingest. The 0.11 releases still sent the previous version.

## 0.11.1

### Patch Changes

- 737e082: A fetch that rejects because the page was hidden, unloading or offline while it was in flight is no longer marked as an error. Its span stays `Unset` and carries the reason in `maple.connection_lost`. A fetch that fails on a visible, online page is still an error.

## 0.11.0

### Minor Changes

- c060d5d: New `privacy.persistence: "memory"` mode keeps all SDK state in memory: no cookies, localStorage, sessionStorage or IndexedDB, and no visitor id. Like consent, the setting is page-global and only ever tightens.

    Opting out now deletes the SDK's cookies on every parent domain instead of probing for them, so an opt-out never writes a cookie and also clears ids written under a broader domain.

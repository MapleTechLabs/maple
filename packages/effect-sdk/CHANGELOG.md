# @maple-dev/effect-sdk

## 0.14.1

### Patch Changes

- c022d7f: Network capture no longer rejects a `fetch` call that succeeded:

    - `fetch` accepts anything it can stringify, such as `fetch(window.location)` or a `URL` from another frame. Capture read a `url` property those values do not have, threw after the response had arrived, and the app's `await fetch(...)` rejected with a `TypeError`. The URL is now read the way `fetch` reads it.
    - A request that does not ask for `keepalive` no longer has its body encoded just to measure it.

- 613df48: Session replay no longer changes how a page's own stylesheet calls fail, and benign browser notices no longer count as session errors:

    - A page whose code calls `insertRule` (or `deleteRule`, `replace`, `replaceSync`, `setProperty`, `removeProperty`) with something the browser rejects gets the browser's exception again. While a recording ran, the call returned `undefined` instead of throwing and the console showed `[maple] session replay recording failed`. CSS-in-JS libraries that insert vendor-prefixed rules and rely on catching the error hit this on every page load. The recording itself was not interrupted.
    - The `ResizeObserver loop` notices and errors thrown by browser extensions are no longer recorded as session errors, so they stop counting toward a session's error total and its "has errors" filter. These are the default error filters that already keep them out of issues; `errors: { defaultFilters: false }` in `@maple-dev/browser` keeps them in both.

- 58c2b10: Capture no longer changes what the app sees, and both SDKs agree on one page:

    - Network capture cannot reject a `fetch` that succeeded. Anything capture throws after the response arrived (a URL filter, a body pattern, reading the body in the background) is dropped, the app gets the real response, and a failed request still rejects with its own error. An XHR's `loadend` bookkeeping can no longer raise an uncaught error on the page.
    - Session events carry the time, page URL and trace id of the moment they happened. Clicks, inputs, errors, navigations, console and network events were stamped when the batch was sent, up to a minute later: a click that navigated was attributed to the destination page, and the trace id was almost always empty.
    - `MapleBrowser.init()` with no argument starts on defaults and warns about the missing `serviceName` instead of throwing. If startup throws, `init()` warns, undoes what had started and returns a handle that does nothing, so telemetry cannot take the app's entrypoint down.
    - With `@maple-dev/browser` and the Effect client on one page, an uncaught error is recorded once and web vitals are reported by one of the two. The Effect client now uses the page-wide error claim and the `webVitals` lease, and tells the page's error listeners (breadcrumbs, replay on error) about the errors it records.
    - The Effect client records no replay for crawlers, as `@maple-dev/browser` already did. They still get a session row and events.
    - The Effect client removes its `privacy.sanitizeUrl` when it stops, so a remount no longer stacks a second copy, and it stops capturing when another Maple SDK on the page turns `privacy.requireConsent` on later.
    - `Maple.layer` (client and server) sends the `x-maple-sdk` header like the other presets; the server layer also names itself in `user-agent`.
    - The session record is no longer JSON-parsed and validated for every span and replay input event: while the stored string is unchanged, the record parsed last time is reused.

- 04fd697: A failed export no longer fills the console:

    - When an export failed (for example a browser's tracking protection blocking the ingest request), the SDK printed `flush skipped (cooldown ...)` on every flush tick of the 60s cooldown, per signal, and `flush failed` again after every failed retry. A blocked endpoint produced about 24 lines a minute for the whole session. Skipped flushes now print nothing, an outage is logged once per signal, and one `flush recovered` line follows when export works again. Buffering, restore and the 60s cooldown are unchanged.
    - Console capture (session replay, breadcrumbs and `logs.captureConsole`) no longer records the SDKs' own `[maple]` and `[MapleClientSDK]` diagnostics as the app's console output, so an export failure is not counted as a session error.

## 0.14.0

### Minor Changes

- a9720c2: Foldkit navigation spans no longer stretch to many minutes:

    - Navigation and pageload timestamps now use the same clock as Effect's spans. After the computer slept, a navigation used to start up to hours before the Commands it caused, so `navigate <route>` spans lasted as long as the sleep.
    - A navigation never ends more than 30 seconds after it started, even when the background tab fired the cap late or a Command ended later. Spans cut at the cap carry `maple.navigation.interrupted: true`.

    New `webVitals` option on `MapleFlush.make` and `MapleFoldkit.make` (default `false`): reports LCP, CLS, INP, FCP and TTFB as `browser.web_vital` log events, loaded in a code-split chunk. In Foldkit apps they link to the `pageload` span.

### Patch Changes

- 82843de: Browser SDK fixes from a correctness review:

    - `tracing.sampleRate` below 1 no longer adds a `tracestate` header to cross-origin requests, so an API that allows only `traceparent` in CORS keeps working (another vendor's trace-state members, when present, are still sent). Same-origin requests still carry it, so their server spans keep their sampling weight; server spans behind a cross-origin API are now weighted 1×.
    - A string in `tracing.propagateTraceHeaderCorsUrls` is now a URL prefix (`"https://api.example.com"` covers every path on that origin). Before, it had to equal the whole request URL, so it almost never matched.
    - A fetch that got no response no longer reports `http.response.status_code: 0`; the HTTP semantic conventions leave the key off.
    - A session that rotated while the previous session's event sink was still live now counts its errors and clicks from zero, instead of hiding as many as the previous session had.
    - Effect client: the page URL and script path on uncaught-error spans are redacted like every other URL, and a standalone session keeps at most 200 trace ids so its final row still fits the unload budget.

- 83e69e9: Read `service.name` and `service.version` from `OTEL_RESOURCE_ATTRIBUTES` when no explicit name or version is set, instead of reporting the service as `unknown`. An explicit `attributes` entry beats the environment, and each key is exported once. All-digit versions such as date build numbers are no longer stamped as `vcs.ref.head.revision`.
- a8506ba: Lifecycle fixes for session replay and the flushable presets:

    - Session replay uploads one chunk at a time. A chunk is cut only after the previous one is answered, so a lost chunk can no longer leave a later stored chunk that depends on a snapshot ingest never received. A page going away still sends its last chunk at once.
    - Effect client: flushes on a hidden tab and on `pagehide` join the queue every other flush uses. They still start at once, alongside a flush already in flight, and any flush called after them now waits for them instead of running over them.
    - Effect client and server `MapleFlush`: `dispose()` now ends the preset. `flush()` calls from the moment `dispose()` starts send nothing, and what is recorded through `layer` during or after the final flush, or what that flush failed to send, is dropped. A second `dispose()` returns the first one's promise instead of flushing and stopping the session again.

## 0.13.1

### Patch Changes

- 1c7c733: The server SDK now reports the `process.runtime.version` resource attribute next to `process.runtime.name`: the Node.js version on Node, `process.versions.bun` on Bun and `Deno.version.deno` on Deno. Cloudflare Workers and other edge runtimes have no meaningful runtime version and leave it unset.

## 0.13.0

### Minor Changes

- 41da0c2: The Cloudflare preset and `MapleFlush.make` export without an ingest key when the endpoint is not Maple's hosted ingest, as `Maple.layer` already does. A Worker or flushable pointed at a local `maple start` or a self-hosted collector no longer needs a placeholder key. Keyless against the hosted ingest, including with nothing configured, still runs in no-op mode, and its notice now also suggests pointing `MAPLE_ENDPOINT` at your own collector.

### Patch Changes

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

- ef33c0d: The browser client's uncaught-error capture no longer reports errors thrown by browser extensions (an extension's script, or a rejection whose top frame is one) or the benign `ResizeObserver loop` notices, as `@maple/browser` already does.
- 13abd6c: Foldkit: the `pageload` span records where the time went before the app started. `maple.pageload.response_start_ms` and `maple.pageload.response_end_ms` are the document's first and last byte. `maple.pageload.init_ms` is when `init` ran. All are ms since navigation start.

## 0.12.1

### Patch Changes

- bf01691: The Foldkit adapter no longer reports slow `update`, `view` or patch phases while the tab is hidden. A background tab is throttled by the browser, so those timings measured the throttling rather than the app.

## 0.12.0

### Minor Changes

- af2b366: Browser telemetry follows the OpenTelemetry conventions more closely. Rename these keys in saved queries, dashboards and alerts:

    - `app.navigation.interrupted` is now `maple.navigation.interrupted` (both SDKs). `app.*` belongs to the semantic conventions.
    - `browser.timezone` is now `maple.browser.timezone` (`@maple-dev/effect-sdk`). It is not a semantic-convention key.
    - An interrupted span (`@maple-dev/effect-sdk`) is still `Ok`, but carries `maple.interrupted: true` instead of a status message, `status.interrupted` and `span.label`. A status message is reserved for `Error`.

    `@maple-dev/effect-sdk` also sets `error.type` on every failed span that lacks one (`TransportError` for a request that never got a response, otherwise the error's name), and browser presets report `telemetry.sdk.name`, `telemetry.sdk.language` (`webjs`) and `telemetry.sdk.version`.

- 75a59ca: New `@maple-dev/effect-sdk/foldkit` entry point for Foldkit apps. `MapleFoldkit.make(config).instrument(appConfig)` wraps a `Runtime.makeApplication` config: Command spans are grouped under the page load or navigation that caused them, Commands that finished without a child span (focus, scroll, hover delays) are dropped, Command args export as `maple.foldkit.arg.<key>`, only ids and flags unless allowed by name, runtime crashes are reported with the recent Message tags, and slow `update`, `view` and DOM patch phases become spans.

### Patch Changes

- f34141f: Add `replay.canvasFps` to record `<canvas>` content, such as charts, in session replays. Off by default, and never with `maskAllText`.
- c463f5c: Report the package's own version in the SDK hint sent to ingest. The 0.11 releases still sent the previous version.
- 7216bb9: Browser: requests cut off by a page unload are exported as `Unset` with `maple.connection_lost`, including the spans that passed the error up, instead of `Error`.

## 0.11.0

### Minor Changes

- 832b7db: `Maple.layer` takes the same span options as `MapleFlush.make` and the Cloudflare `make`, and all three classify spans the same way. New on every preset: `dropSpanSubtrees` drops a span and everything under it, `dropSpan` drops a finished span by predicate, and `isAnticipatedError` is the predicate form of `anticipatedErrorIdentifiers`. A server span that answered 5xx stays an error even when its failure is anticipated. On `Maple.layer`, unmatched-route 404 spans are now dropped and server spans that rendered a 5xx are recorded as errors, which can surface new error groups.

## 0.10.2

### Patch Changes

- 737e082: Raw HTTP client spans no longer open error issues for failures the caller already handled. A 4xx client span keeps its `Error` status but no longer carries an `exception` event, so error tracking leaves the issue to the caller's span: one that does not handle the 4xx still fails and reports it. In the browser preset, a request that fails in transport while the page was hidden, unloading or offline exports as `Unset` with the reason in `maple.connection_lost`.

## 0.10.1

### Patch Changes

- ed8a412: A 5xx server span keeps its `HttpServerErrorResponse` exception on Effect 4.0.2 and later, which now fails the span itself with an `HttpServerError` for any 5xx response. Without this, those responses were grouped as one generic `HttpServerError` issue.

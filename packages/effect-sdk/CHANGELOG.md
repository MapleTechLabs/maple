# @maple-dev/effect-sdk

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

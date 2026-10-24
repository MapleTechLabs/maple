# @maple-dev/effect-sdk

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

# @maple-dev/browser

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

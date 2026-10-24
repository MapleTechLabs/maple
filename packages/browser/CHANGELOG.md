# @maple-dev/browser

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

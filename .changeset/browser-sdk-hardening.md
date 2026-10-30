---
"@maple-dev/browser": minor
"@maple-dev/effect-sdk": patch
---

Session replay keeps the last moments of a visit. A chunk recorded as the page goes away is sent before the page is torn down when it fits the unload size limit (24 KiB), so a short visit now has a recording and a session keeps its final seconds. A larger final chunk is still kept in the tab and sent by the next page load of the site. Replay also survives a failed upload (the next chunk starts from a fresh snapshot), records without `CompressionStream`, keeps recording across a tab switch without a new full snapshot, and stops once a session hits its size cap instead of retrying on every page load.

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

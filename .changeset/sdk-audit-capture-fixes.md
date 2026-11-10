---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Capture no longer changes what the app sees, and both SDKs agree on one page:

- Network capture cannot reject a `fetch` that succeeded. Anything capture throws after the response arrived (a URL filter, a body pattern, reading the body in the background) is dropped, the app gets the real response, and a failed request still rejects with its own error. An XHR's `loadend` bookkeeping can no longer raise an uncaught error on the page.
- Session events carry the time, page URL and trace id of the moment they happened. Clicks, inputs, errors, navigations, console and network events were stamped when the batch was sent, up to a minute later: a click that navigated was attributed to the destination page, and the trace id was almost always empty.
- `MapleBrowser.init()` with no argument starts on defaults and warns about the missing `serviceName` instead of throwing. If startup throws, `init()` warns, undoes what had started and returns a handle that does nothing, so telemetry cannot take the app's entrypoint down.
- With `@maple-dev/browser` and the Effect client on one page, an uncaught error is recorded once and web vitals are reported by one of the two. The Effect client now uses the page-wide error claim and the `webVitals` lease, and tells the page's error listeners (breadcrumbs, replay on error) about the errors it records.
- The Effect client records no replay for crawlers, as `@maple-dev/browser` already did. They still get a session row and events.
- The Effect client removes its `privacy.sanitizeUrl` when it stops, so a remount no longer stacks a second copy, and it stops capturing when another Maple SDK on the page turns `privacy.requireConsent` on later.
- `Maple.layer` (client and server) sends the `x-maple-sdk` header like the other presets; the server layer also names itself in `user-agent`.
- The session record is no longer JSON-parsed and validated for every span and replay input event: while the stored string is unchanged, the record parsed last time is reused.

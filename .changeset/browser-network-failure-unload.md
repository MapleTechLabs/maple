---
"@maple-dev/browser": minor
---

Requests that a reload or redirect cancels a moment before the page unloads are no longer reported as errors: their spans stay `Unset` with `maple.connection_lost: "page_unload"`, and their unhandled `fetch()` rejections are dropped. An unhandled `fetch()` rejection is also no longer reported when its request span already stays `Unset` because the page was hidden or went offline while it was in flight. New `errors.ignoreNetworkFailuresFor` lists request URLs (a string is an absolute URL prefix, a RegExp is tested against the full URL) whose network failures are not errors, such as third-party beacons an ad blocker stops; their spans stay `Unset` with `maple.network_failure_ignored`.

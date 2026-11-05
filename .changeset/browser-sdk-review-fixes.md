---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Browser SDK fixes from a correctness review:

- `tracing.sampleRate` below 1 no longer sends a `tracestate` header with traced requests, so a cross-origin API that allows only `traceparent` in CORS keeps working. The exported span still carries the sampling threshold.
- A string in `tracing.propagateTraceHeaderCorsUrls` is now a URL prefix (`"https://api.example.com"` covers every path on that origin). Before, it had to equal the whole request URL, so it almost never matched.
- A fetch that got no response no longer reports `http.response.status_code: 0`; the HTTP semantic conventions leave the key off.
- A session that rotated while the previous session's event sink was still live now counts its errors and clicks from zero, instead of hiding as many as the previous session had.
- Effect client: the page URL and script path on uncaught-error spans are redacted like every other URL, and a standalone session keeps at most 200 trace ids so its final row still fits the unload budget.
